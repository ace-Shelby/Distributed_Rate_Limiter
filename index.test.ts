import { describe, expect, test } from "bun:test";
import {
  asRateLimitKey,
  asTierName,
  buildRateLimitHeaders,
  createRateLimiter,
  type RateLimitResult,
  type RedisClient,
} from "./index";

interface EvalCall {
  script: string;
  numberOfKeys: number;
  args: Array<string | number>;
}

class MockRedis implements RedisClient {
  calls: EvalCall[] = [];

  constructor(private readonly responses: Array<unknown | Error>) {}

  async evalScript(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    this.calls.push({ script, numberOfKeys, args });

    const response = this.responses.shift();
    if (response instanceof Error) {
      throw response;
    }

    if (response === undefined) {
      throw new Error("MockRedis received evalScript without a queued response");
    }

    return response;
  }
}

function request(headers: HeadersInit = {}): Request {
  return new Request("https://example.test/api/data", { headers });
}

function result(overrides: Partial<RateLimitResult>): RateLimitResult {
  return {
    allowed: true,
    status: "allowed",
    remaining: 7,
    limit: 10,
    resetAt: 123,
    retryAfter: 0,
    tier: asTierName("free"),
    key: asRateLimitKey("user-1"),
    algorithm: "token-bucket",
    failOpen: false,
    ...overrides,
  };
}

describe("buildRateLimitHeaders", () => {
  test("builds rate-limit headers and only includes Retry-After for denied requests", () => {
    const allowedHeaders = buildRateLimitHeaders(result({}));

    expect(allowedHeaders.get("X-RateLimit-Limit")).toBe("10");
    expect(allowedHeaders.get("X-RateLimit-Remaining")).toBe("7");
    expect(allowedHeaders.get("X-RateLimit-Reset")).toBe("123");
    expect(allowedHeaders.get("X-RateLimit-Tier")).toBe("free");
    expect(allowedHeaders.get("X-RateLimit-Algorithm")).toBe("token-bucket");
    expect(allowedHeaders.has("Retry-After")).toBe(false);

    const resetAt = Math.floor(Date.now() / 1000) + 30;
    const deniedHeaders = buildRateLimitHeaders(
      result({
        allowed: false,
        status: "limited",
        remaining: 0,
        resetAt,
        retryAfter: 30,
        tier: asTierName("pro"),
        key: asRateLimitKey("user-2"),
      }),
    );

    expect(Number(deniedHeaders.get("Retry-After"))).toBeGreaterThanOrEqual(29);
    expect(Number(deniedHeaders.get("Retry-After"))).toBeLessThanOrEqual(30);

    const failOpenHeaders = buildRateLimitHeaders(
      result({ status: "fail-open", failOpen: true }),
    );
    expect(failOpenHeaders.get("X-RateLimit-Fail-Open")).toBe("true");
  });
});

describe("createRateLimiter", () => {
  test("supports direct server-resolved subject checks without Request callbacks", async () => {
    const redis = new MockRedis([[1, 199, 100]]);
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: {
        free: { maxTokens: 10, refillRate: 1 },
        pro: { maxTokens: 200, refillRate: 3.33 },
      },
      defaultTier: asTierName("free"),
      hashKeys: false,
    });

    const rateLimitResult = await limiter.check({
      key: "client_123",
      tier: "pro",
    });

    expect(rateLimitResult.allowed).toBe(true);
    expect(String(rateLimitResult.key)).toBe("client_123");
    expect(String(rateLimitResult.tier)).toBe("pro");
    expect(rateLimitResult.limit).toBe(200);
    expect(redis.calls[0]?.args[0]).toBe(
      "ratelimit:token-bucket:pro:client_123",
    );

    await expect(limiter(request())).rejects.toThrow("keyGenerator is required");
  });

  test("evaluates the selected token bucket tier with one Redis EVAL", async () => {
    const redis = new MockRedis([[1, 42, 9001]]);
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: {
        free: { maxTokens: 30, refillRate: 0.5 },
        pro: { maxTokens: 200, refillRate: 3.33, algorithm: "token-bucket" },
      },
      defaultTier: asTierName("free"),
      keyGenerator: (req) => req.headers.get("x-api-key") ?? "anonymous",
      tierIdentifier: (req) => req.headers.get("x-plan") ?? undefined,
    });

    const rateLimitResult = await limiter(
      request({ "x-api-key": "user-abc", "x-plan": "pro" }),
    );

    expect(rateLimitResult.allowed).toBe(true);
    expect(rateLimitResult.status).toBe("allowed");
    expect(rateLimitResult.remaining).toBe(42);
    expect(rateLimitResult.limit).toBe(200);
    expect(rateLimitResult.resetAt).toBe(9001);
    expect(rateLimitResult.retryAfter).toBe(0);
    expect(String(rateLimitResult.tier)).toBe("pro");
    expect(String(rateLimitResult.key)).toBe("user-abc");
    expect(rateLimitResult.algorithm).toBe("token-bucket");
    expect(rateLimitResult.failOpen).toBe(false);
    expect(redis.calls).toHaveLength(1);
    expect(redis.calls[0]?.numberOfKeys).toBe(1);
    expect(redis.calls[0]?.args[0]).toMatch(
      /^ratelimit:token-bucket:pro:[A-Za-z0-9_-]{43}$/,
    );
    expect(String(redis.calls[0]?.args[0])).not.toContain("user-abc");
    expect(redis.calls[0]?.args.slice(1, 4)).toEqual([200, 3.33, 300]);
  });

  test("passes cost=1 by default and custom cost when specified", async () => {
    const redis = new MockRedis([[1, 42, 9001], [1, 37, 9001]]);
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: { free: { maxTokens: 50, refillRate: 1 } },
      defaultTier: asTierName("free"),
      hashKeys: false,
    });

    await limiter.check({ key: "user-a" });
    expect(redis.calls[0]?.args[4]).toBe(1);

    await limiter.check({ key: "user-a", cost: 5 });
    expect(redis.calls[1]?.args[4]).toBe(5);
  });

  test("rejects invalid cost values", async () => {
    const redis = new MockRedis([]);
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: { free: { maxTokens: 10, refillRate: 1 } },
      defaultTier: asTierName("free"),
    });

    await expect(limiter.check({ key: "x", cost: 0 })).rejects.toThrow("cost must be a positive integer");
    await expect(limiter.check({ key: "x", cost: -1 })).rejects.toThrow("cost must be a positive integer");
    await expect(limiter.check({ key: "x", cost: 1.5 })).rejects.toThrow("cost must be a positive integer");
  });

  test("can keep Redis key segments inspectable when hashKeys is false", async () => {
    const redis = new MockRedis([[1, 9, 100]]);
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: {
        free: { maxTokens: 10, refillRate: 1 },
      },
      defaultTier: asTierName("free"),
      keyGenerator: () => "user abc/123",
      hashKeys: false,
    });

    await limiter(request());

    expect(redis.calls[0]?.args[0]).toBe(
      "ratelimit:token-bucket:free:user%20abc%2F123",
    );
  });

  test("falls back to the default tier when an unknown tier is returned", async () => {
    const redis = new MockRedis([[1, 9, 100]]);
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: {
        free: { maxTokens: 10, refillRate: 1 },
      },
      defaultTier: asTierName("free"),
      keyGenerator: () => "user-abc",
      tierIdentifier: () => "enterprise",
      hashKeys: false,
    });

    const rateLimitResult = await limiter(request());

    expect(String(rateLimitResult.tier)).toBe("free");
    expect(redis.calls[0]?.args[0]).toBe("ratelimit:token-bucket:free:user-abc");
  });

  test("supports async key and tier lookup for server-side plan data", async () => {
    const redis = new MockRedis([[1, 199, 100]]);
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: {
        free: { maxTokens: 10, refillRate: 1 },
        pro: { maxTokens: 200, refillRate: 3.33 },
      },
      defaultTier: asTierName("free"),
      keyGenerator: async (req) => req.headers.get("x-api-key") ?? "anonymous",
      tierIdentifier: async (req) => {
        const apiKey = req.headers.get("x-api-key");
        return apiKey === "pro-demo-key" ? "pro" : undefined;
      },
      hashKeys: false,
    });

    const rateLimitResult = await limiter(
      request({ "x-api-key": "pro-demo-key" }),
    );

    expect(String(rateLimitResult.tier)).toBe("pro");
    expect(rateLimitResult.limit).toBe(200);
    expect(redis.calls[0]?.args[0]).toBe(
      "ratelimit:token-bucket:pro:pro-demo-key",
    );
  });

  test("calls onLimitReached when Redis denies a sliding-window request", async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 60;
    const redis = new MockRedis([[0, 0, resetAt]]);
    const deniedResults: RateLimitResult[] = [];
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: {
        strict: { maxTokens: 20, refillRate: 60, algorithm: "sliding-window" },
      },
      defaultTier: asTierName("strict"),
      keyGenerator: () => "user-abc",
      hashKeys: false,
      onLimitReached: (rateLimitResult) => deniedResults.push(rateLimitResult),
    });

    const rateLimitResult = await limiter(request());

    expect(rateLimitResult.allowed).toBe(false);
    expect(rateLimitResult.status).toBe("limited");
    expect(rateLimitResult.remaining).toBe(0);
    expect(rateLimitResult.retryAfter).toBeGreaterThanOrEqual(59);
    expect(deniedResults).toHaveLength(1);
    expect(redis.calls[0]?.args[0]).toBe("ratelimit:sliding-window:strict:user-abc");
    expect(redis.calls[0]?.args.slice(1, 4)).toEqual([20, 60, 300]);
    expect(typeof redis.calls[0]?.args[4]).toBe("string");
  });

  test("uses a longer TTL for sliding windows longer than the default TTL", async () => {
    const redis = new MockRedis([[1, 99, 100]]);
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: {
        strict: { maxTokens: 100, refillRate: 900, algorithm: "sliding-window" },
      },
      defaultTier: asTierName("strict"),
      keyGenerator: () => "user-abc",
      hashKeys: false,
    });

    await limiter(request());

    expect(redis.calls[0]?.args.slice(1, 4)).toEqual([100, 900, 900]);
  });

  test("opens the circuit after repeated Redis failures and fails open without Redis", async () => {
    const redis = new MockRedis([
      new Error("redis timeout 1"),
      new Error("redis timeout 2"),
      [1, 3, 999],
    ]);
    const errors: Error[] = [];
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: {
        free: { maxTokens: 5, refillRate: 1 },
      },
      defaultTier: asTierName("free"),
      keyGenerator: () => "user-abc",
      circuitBreakerThreshold: 2,
      circuitBreakerResetMs: 10_000,
      onError: (error) => errors.push(error),
    });

    const first = await limiter(request());
    const second = await limiter(request());
    const third = await limiter(request());

    expect(first.allowed).toBe(true);
    expect(first.status).toBe("fail-open");
    expect(second.allowed).toBe(true);
    expect(second.status).toBe("fail-open");
    expect(third.allowed).toBe(true);
    expect(third.status).toBe("fail-open");
    expect(third.failOpen).toBe(true);
    expect(third.remaining).toBe(5);
    expect(third.limit).toBe(5);
    expect(errors).toHaveLength(2);
    expect(redis.calls).toHaveLength(2);
  });

  test("allows a half-open probe after the reset interval", async () => {
    const redis = new MockRedis([new Error("redis down"), [1, 4, 777]]);
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: {
        free: { maxTokens: 5, refillRate: 1 },
      },
      defaultTier: asTierName("free"),
      keyGenerator: () => "user-abc",
      circuitBreakerThreshold: 1,
      circuitBreakerResetMs: 0,
    });

    await limiter(request());
    const probe = await limiter(request());

    expect(probe.allowed).toBe(true);
    expect(probe.status).toBe("allowed");
    expect(probe.remaining).toBe(4);
    expect(probe.resetAt).toBe(777);
    expect(String(probe.tier)).toBe("free");
    expect(String(probe.key)).toBe("user-abc");
    expect(redis.calls).toHaveLength(2);
  });

  test("rejects invalid tier names and empty keys", async () => {
    expect(() =>
      createRateLimiter({
        redisClient: new MockRedis([]),
        tiers: {
          "bad tier": { maxTokens: 10, refillRate: 1 },
        },
        defaultTier: asTierName("bad tier"),
        keyGenerator: () => "user-abc",
      }),
    ).toThrow("Tier");

    const limiter = createRateLimiter({
      redisClient: new MockRedis([]),
      tiers: {
        free: { maxTokens: 10, refillRate: 1 },
      },
      defaultTier: asTierName("free"),
      keyGenerator: () => "",
    });

    await expect(limiter(request())).rejects.toThrow("non-empty string");
  });

  test("supports the windowSeconds alias for sliding-window tiers", async () => {
    const redis = new MockRedis([[1, 99, 100]]);
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: {
        strict: { maxTokens: 100, windowSeconds: 60, algorithm: "sliding-window" },
      } as Record<string, any>,
      defaultTier: asTierName("strict"),
      hashKeys: false,
      keyGenerator: () => "user-abc",
    });

    await limiter(request());
    expect(redis.calls[0]?.args.slice(1, 4)).toEqual([100, 60, 300]);
  });

  test("supports fixed-window algorithm", async () => {
    const redis = new MockRedis([[1, 99, 1700000060]]);
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: {
        basic: { maxTokens: 100, refillRate: 60, algorithm: "fixed-window" },
      },
      defaultTier: asTierName("basic"),
      hashKeys: false,
      keyGenerator: () => "user-abc",
    });

    const rateLimitResult = await limiter(request());

    expect(rateLimitResult.allowed).toBe(true);
    expect(rateLimitResult.algorithm).toBe("fixed-window");
    expect(redis.calls[0]?.args[0]).toBe("ratelimit:fixed-window:basic:user-abc");
  });

  test("peek() returns remaining without consuming tokens", async () => {
    const redis = new MockRedis([[1, 9, 100]]);
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: { free: { maxTokens: 10, refillRate: 1 } },
      defaultTier: asTierName("free"),
      hashKeys: false,
    });

    const peekResult = await limiter.peek({ key: "user-abc" });

    expect(peekResult.allowed).toBe(true);
    expect(peekResult.remaining).toBe(9);
    expect(redis.calls).toHaveLength(1);
    // Peek script should NOT have a cost/member argument
    expect(redis.calls[0]?.args.length).toBe(3); // key, maxTokens, refillRate
  });

  test("peek() fails open on Redis error", async () => {
    const redis = new MockRedis([new Error("redis down")]);
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: { free: { maxTokens: 10, refillRate: 1 } },
      defaultTier: asTierName("free"),
      hashKeys: false,
    });

    const peekResult = await limiter.peek({ key: "user-abc" });

    expect(peekResult.allowed).toBe(true);
    expect(peekResult.failOpen).toBe(true);
  });

  test("reset() deletes the Redis key for a subject", async () => {
    const redis = new MockRedis([1]);
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: { free: { maxTokens: 10, refillRate: 1 } },
      defaultTier: asTierName("free"),
      hashKeys: false,
    });

    const deleted = await limiter.reset({ key: "user-abc" });

    expect(deleted).toBe(true);
    expect(redis.calls).toHaveLength(1);
  });

  test("reset() returns false on Redis error", async () => {
    const redis = new MockRedis([new Error("redis down")]);
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: { free: { maxTokens: 10, refillRate: 1 } },
      defaultTier: asTierName("free"),
      hashKeys: false,
    });

    const deleted = await limiter.reset({ key: "user-abc" });
    expect(deleted).toBe(false);
  });

  test("getStatus() returns circuit breaker state", async () => {
    const redis = new MockRedis([new Error("redis down")]);
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: { free: { maxTokens: 5, refillRate: 1 } },
      defaultTier: asTierName("free"),
      keyGenerator: () => "user-abc",
      circuitBreakerThreshold: 1,
    });

    expect(limiter.getStatus().state).toBe("closed");
    expect(limiter.getStatus().failureCount).toBe(0);

    await limiter(request());

    expect(limiter.getStatus().state).toBe("open");
    expect(limiter.getStatus().failureCount).toBe(1);
    expect(limiter.getStatus().openedAt).toBeGreaterThan(0);
  });

  test("maxTokens=1 works correctly as a strict single-request limiter", async () => {
    const redis = new MockRedis([[1, 0, 100]]);
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: { strict: { maxTokens: 1, refillRate: 1 } },
      defaultTier: asTierName("strict"),
      hashKeys: false,
    });

    const rateLimitResult = await limiter.check({ key: "user-abc" });
    expect(rateLimitResult.allowed).toBe(true);
    expect(rateLimitResult.remaining).toBe(0);
  });

  test("rejects missing redisClient", () => {
    expect(() =>
      createRateLimiter({
        redisClient: {} as any,
        tiers: { free: { maxTokens: 10, refillRate: 1 } },
        defaultTier: asTierName("free"),
      }),
    ).toThrow("redisClient must implement evalScript");
  });

  test("rejects non-function keyGenerator", () => {
    expect(() =>
      createRateLimiter({
        redisClient: new MockRedis([]),
        tiers: { free: { maxTokens: 10, refillRate: 1 } },
        defaultTier: asTierName("free"),
        keyGenerator: "not-a-function" as any,
      }),
    ).toThrow("keyGenerator must be a function");
  });

  test("rejects negative keyTtlSeconds", () => {
    expect(() =>
      createRateLimiter({
        redisClient: new MockRedis([]),
        tiers: { free: { maxTokens: 10, refillRate: 1 } },
        defaultTier: asTierName("free"),
        keyTtlSeconds: -1,
      }),
    ).toThrow("keyTtlSeconds must be a positive integer");
  });

  test("uses longer TTL for fixed-window tiers longer than default TTL", async () => {
    const redis = new MockRedis([[1, 99, 100]]);
    const limiter = createRateLimiter({
      redisClient: redis,
      tiers: {
        hourly: { maxTokens: 100, refillRate: 3600, algorithm: "fixed-window" },
      },
      defaultTier: asTierName("hourly"),
      keyGenerator: () => "user-abc",
      hashKeys: false,
    });

    await limiter(request());

    expect(redis.calls[0]?.args.slice(1, 4)).toEqual([100, 3600, 3600]);
  });
});
