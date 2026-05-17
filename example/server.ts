import Redis from "ioredis";
import {
  asTierName,
  buildRateLimitHeaders,
  createRateLimiter,
  wrapRedisClient,
} from "../index";

const port = Number.parseInt(Bun.env.PORT ?? "1707", 10);
const redisUrl = Bun.env.REDIS_URL;
const demoClients = new Map([
  ["free-demo-key", "free"],
  ["pro-demo-key", "pro"],
  ["strict-demo-key", "strict"],
]);

const redis = redisUrl
  ? new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    })
  : new Redis({
      host: Bun.env.REDIS_HOST ?? "127.0.0.1",
      port: Number.parseInt(Bun.env.REDIS_PORT ?? "6379", 10),
      username: Bun.env.REDIS_USERNAME,
      password: Bun.env.REDIS_PASSWORD,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });

let lastRedisConnectionError = "";

redis.on("error", (error) => {
  if (error.message === lastRedisConnectionError) {
    return;
  }

  lastRedisConnectionError = error.message;
  console.error(`Redis connection error: ${error.message}`);

  if (error.message.includes("NOAUTH") || error.message.includes("WRONGPASS")) {
    console.error(
      "Set REDIS_PASSWORD or REDIS_URL, for example: REDIS_PASSWORD=secret bun server.ts",
    );
  }
});

try {
  await redis.connect();
  console.info("Redis connected");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Redis unavailable at startup; requests will fail open: ${message}`);
}

const limiter = createRateLimiter({
  redisClient: wrapRedisClient(redis),
  tiers: {
    free: { maxTokens: 20, refillRate: 1, algorithm: "token-bucket" },
    pro: { maxTokens: 200, refillRate: 3.33, algorithm: "token-bucket" },
    strict: { maxTokens: 20, refillRate: 60, algorithm: "sliding-window" },
  },
  defaultTier: asTierName("free"),
  onLimitReached: (result) => {
    console.info("rate limit reached", {
      key: result.key,
      tier: result.tier,
      resetAt: result.resetAt,
    });
  },
  onError: (error) => {
    console.error("redis unavailable; failing open", error);
  },
});

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname !== "/api/data") {
      return new Response("Not Found", { status: 404 });
    }

    const apiKey = req.headers.get("x-api-key") ?? "anonymous";
    const result = await limiter.check({
      key: apiKey,
      tier: demoClients.get(apiKey),
    });
    const headers = buildRateLimitHeaders(result);

    if (!result.allowed) {
      return Response.json(
        {
          ok: false,
          error: "Too Many Requests",
          tier: result.tier,
          remaining: result.remaining,
          retryAfter: result.retryAfter,
        },
        { status: 429, headers },
      );
    }

    return Response.json(
      {
        ok: true,
        tier: result.tier,
        algorithm: result.algorithm,
        remaining: result.remaining,
        limit: result.limit,
        failOpen: result.failOpen,
      },
      { headers },
    );
  },
});

console.info(`Example server listening on http://localhost:${port}/api/data`);
