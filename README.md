# bun-redis-throttle

[![CI](https://github.com/harshpreet-singh/bun-redis-throttle/actions/workflows/ci.yml/badge.svg)](https://github.com/harshpreet-singh/bun-redis-throttle/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/bun-redis-throttle.svg)](https://www.npmjs.com/package/bun-redis-throttle)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Distributed API rate limiting for Bun + Redis.**
Token Bucket, Sliding Window & Fixed Window algorithms via atomic Lua scripts. Zero race conditions across replicas.

```bash
bun add bun-redis-throttle ioredis
```

---

## Why this exists

Every rate limiter tutorial shows you an in-memory counter with `setInterval`. That works for a single process. It breaks the moment you have two replicas behind a load balancer: each replica maintains its own counter, so a client can hit 2x your limit by round-robining requests.

This library fixes that with **atomic Lua scripts on Redis**. All counter logic runs inside a single `EVAL` call: no `GET`/`SET` race condition, no MULTI/EXEC boilerplate, no distributed lock overhead. Redis executes it as one indivisible operation regardless of how many replicas you run.

---

## Features

| | |
|---|---|
| **Three algorithms** | Token Bucket (smooth bursting), Sliding Window (strict enforcement), and Fixed Window (lightweight counting), selectable per tier |
| **Atomic by design** | All state mutations happen inside a single Redis `EVAL`. No race conditions. |
| **Circuit breaker** | Consecutive Redis failures open the circuit; requests fail-open so your API stays up |
| **Cost parameter** | Expensive endpoints can consume multiple tokens per request |
| **Peek & Reset** | `peek()` checks remaining without consuming; `reset()` clears state for admin workflows |
| **Health checks** | `getStatus()` exposes circuit breaker state for your `/health` endpoint |
| **Inversion of Control** | You initialize and own the Redis client. Cluster, Sentinel, TLS: your call |
| **Observability hooks** | `onLimitReached` and `onError` callbacks for your metrics and alerting pipelines |
| **Standard headers** | `buildRateLimitHeaders()` utility builds `X-RateLimit-*` + `Retry-After` for you |
| **Branded types** | `RateLimitKey` and `TierName` prevent stringly-typed bugs at compile time |
| **Safe Redis keys** | Generated Redis keys hash user identifiers by default so API keys do not leak into key names |
| **Automatic TTL** | Redis keys expire after 300 seconds of inactivity; windows longer than 300 seconds keep state for the full window |

---

## Quick start

```typescript
import Redis from "ioredis";
import { asTierName, createRateLimiter, buildRateLimitHeaders } from "bun-redis-throttle";

const redis = new Redis({ host: "127.0.0.1", port: 6379 });

const apiKeyPlans = new Map([
  ["key_free_123", "free"],
  ["key_pro_456", "pro"],
]);

async function resolveClient(req: Request) {
  const apiKey = req.headers.get("x-api-key");
  if (!apiKey) return { id: "anonymous", tier: undefined };
  return { id: apiKey, tier: apiKeyPlans.get(apiKey) };
}

const limiter = createRateLimiter({
  redisClient: redis,
  tiers: {
    free: { maxTokens: 30, refillRate: 0.5, algorithm: "token-bucket" },
    pro:  { maxTokens: 200, refillRate: 3.33, algorithm: "token-bucket" },
  },
  defaultTier: asTierName("free"),
  onLimitReached: (result) => metrics.increment("rate_limit.blocked", { tier: result.tier }),
  onError: (err) => alerts.fire("redis_degraded", err),
});

Bun.serve({
  async fetch(req) {
    const client = await resolveClient(req);
    const result = await limiter.check({ key: client.id, tier: client.tier });
    const headers = buildRateLimitHeaders(result);

    if (!result.allowed) {
      return new Response("Too Many Requests", { status: 429, headers });
    }
    return new Response("OK", { headers });
  },
});
```

---

## Cost parameter

Expensive endpoints can consume more than one token per request:

```typescript
// Image generation costs 5 tokens
const result = await limiter.check({ key: userId, tier: "pro", cost: 5 });

// Normal API call costs 1 token (default)
const result = await limiter.check({ key: userId, tier: "pro" });
```

---

## Peek, Reset & Health Checks

```typescript
// Check remaining without consuming tokens — useful for UI indicators
const status = await limiter.peek({ key: userId });
console.log(`${status.remaining} requests left`);

// Force-reset rate limit state — admin support tool
const deleted = await limiter.reset({ key: problematicUserId });

// Circuit breaker health check — wire into /health endpoint
const health = limiter.getStatus();
// { state: "closed", failureCount: 0, openedAt: null }
```

---

## Algorithms

### Token Bucket: `"token-bucket"`

Best for APIs where you want to **allow bursting** while enforcing a long-term average rate.

A bucket holds up to `maxTokens` tokens. Each request consumes `cost` tokens (default: 1). Tokens refill continuously at `refillRate` per second.

```text
capacity  ####################  60 tokens
burst     ####################  fire all 60 immediately
refill    . . . . . . . . . .   1 token/sec after that
```

### Sliding Window Log: `"sliding-window"`

Best for billing-critical or SLA-bound APIs where **exact enforcement** matters more than burst allowance.

Tracks every request timestamp in a sorted set. `maxTokens: 1000, refillRate: 60` means exactly 1000 requests per 60-second rolling window.

```text
window  [---------------- 60 sec ----------------]
now ->  >>>>>>>>>>>>>>>>>  oldest evicted as new arrive
limit   1000 req in any 60-sec slice
```

### Fixed Window: `"fixed-window"`

Best for **high-throughput** APIs where you want simple counting per time window with minimal Redis memory.

Uses a simple counter per aligned time window. `maxTokens: 1000, refillRate: 60` means 1000 requests per 60-second fixed window. Lower memory than sliding-window (one key vs sorted set), but allows boundary spikes.

```text
window  [--- 60 sec ---][--- 60 sec ---]
count   ████████░░░░░░░  counter resets each window
limit   1000 req per window
```

> **Tip:** Use `windowSeconds` instead of `refillRate` for clearer intent:
> ```typescript
> { maxTokens: 1000, windowSeconds: 60, algorithm: "fixed-window" }
> ```

---

## Changing tiers

The safest production pattern is to resolve the client and tier in your own server code, then feed the resolved identity to the limiter:

```typescript
const client = await db.clients.findByApiKey(apiKey);

const result = await limiter.check({
  key: client.id,
  tier: client.plan, // "free", "pro", "enterprise", etc.
});
```

This keeps authentication, billing, and authorization outside the library.

If you prefer a Request-shaped adapter, configure `keyGenerator` and `tierIdentifier`:

```typescript
const limiter = createRateLimiter({
  redisClient,
  tiers,
  defaultTier: asTierName("free"),
  keyGenerator: (req) => req.headers.get("x-api-key") ?? "anonymous",
  tierIdentifier: async (req) => {
    const apiKey = req.headers.get("x-api-key");
    if (!apiKey) return undefined;
    const client = await db.clients.findByApiKey(apiKey);
    return client?.plan;
  },
});

const result = await limiter(req);
```

> **⚠️ Do not let public clients choose their own tier.** Never trust `req.headers.get("x-plan")` from external traffic.

---

## Configuration reference

```typescript
interface RateLimiterOptions {
  /** An initialized ioredis-compatible client. You manage the lifecycle. */
  redisClient: RedisClient;

  /** Tier name -> config map. At least one required. */
  tiers: Record<string, TierConfig>;

  /** Fallback tier when tierIdentifier returns undefined or an unknown tier. */
  defaultTier: TierName;

  /** Optional Request adapter: extracts a stable key from the request. */
  keyGenerator?: (req: Request) => string | Promise<string>;

  /** Optional Request adapter: maps a request to a tier name. */
  tierIdentifier?: (req: Request) => string | undefined | Promise<string | undefined>;

  /** Redis key namespace. Default: "ratelimit" */
  keyPrefix?: string;

  /** Inactivity TTL for Redis keys. Default: 300 */
  keyTtlSeconds?: number;

  /** Hash user keys before writing Redis key names. Default: true */
  hashKeys?: boolean;

  /** Called when a request is denied. Wire to Prometheus, Datadog, or StatsD. */
  onLimitReached?: (result: RateLimitResult) => void;

  /** Called on Redis errors. Wire to PagerDuty or OpsGenie. */
  onError?: (error: Error, req: Request) => void;

  /** Consecutive failures before opening the circuit breaker. Default: 5 */
  circuitBreakerThreshold?: number;

  /** How long in ms to keep circuit open before a half-open probe. Default: 10000 */
  circuitBreakerResetMs?: number;
}

interface TierConfig {
  maxTokens: number;        // burst cap | max requests per window
  refillRate: number;       // tokens/sec | window size in seconds
  windowSeconds?: number;   // alias for refillRate (sliding/fixed window)
  algorithm?: "token-bucket" | "sliding-window" | "fixed-window";
}

interface RateLimitSubject {
  key: string | RateLimitKey;
  tier?: string | TierName;
  cost?: number;            // tokens to consume (default: 1)
}

interface RateLimiter {
  /** Convenience Request adapter. Requires keyGenerator in options. */
  (req: Request): Promise<RateLimitResult>;

  /** Production-first API for already-authenticated clients. */
  check(subject: RateLimitSubject): Promise<RateLimitResult>;

  /** Check remaining without consuming tokens. */
  peek(subject: RateLimitSubject): Promise<RateLimitResult>;

  /** Force-reset rate limit state for a key. */
  reset(subject: RateLimitSubject): Promise<boolean>;

  /** Circuit breaker health check. */
  getStatus(): CircuitBreakerStatus;
}
```

---

## Response shape

```typescript
interface RateLimitResult {
  allowed: boolean;
  status: "allowed" | "limited" | "fail-open";
  remaining: number;
  limit: number;
  resetAt: number;       // Unix timestamp (sec)
  retryAfter: number;    // seconds until retry, 0 when allowed
  tier: TierName;
  key: RateLimitKey;
  algorithm: "token-bucket" | "sliding-window" | "fixed-window";
  failOpen: boolean;
}
```

Use `buildRateLimitHeaders(result)` to turn this into HTTP headers:

```text
X-RateLimit-Limit:     200
X-RateLimit-Remaining: 47
X-RateLimit-Reset:     1718023460
X-RateLimit-Tier:      pro
X-RateLimit-Algorithm: token-bucket
Retry-After:           12
```

---

## Framework examples

### Elysia

```typescript
import { Elysia } from "elysia";

const app = new Elysia()
  .derive(async ({ request }) => {
    const result = await limiter.check({ key: getApiKey(request) });
    return { rateLimit: result };
  })
  .onBeforeHandle(({ rateLimit, set }) => {
    if (!rateLimit.allowed) {
      set.status = 429;
      set.headers = Object.fromEntries(buildRateLimitHeaders(rateLimit));
      return "Too Many Requests";
    }
  })
  .get("/api/data", () => ({ ok: true }));
```

### Hono

```typescript
import { Hono } from "hono";

const app = new Hono();

app.use("*", async (c, next) => {
  const result = await limiter.check({ key: c.req.header("x-api-key") ?? "anon" });
  if (!result.allowed) {
    const headers = buildRateLimitHeaders(result);
    return c.json({ error: "Too Many Requests" }, 429, Object.fromEntries(headers));
  }
  await next();
});
```

---

## System design notes

### Why Lua over transactions?

Redis `MULTI`/`EXEC` prevents interleaving but requires multiple round trips and retry handling under contention. A Lua script executes atomically in a **single round trip**. At scale, that latency and contention difference matters.

### Why IoC for the Redis client?

A library that creates its own Redis connection is a liability. You cannot share a connection pool, configure TLS/Sentinel/Cluster, or control retry behavior. `bun-redis-throttle` takes a client reference and calls `eval` on it. Everything else is yours.

### Why a Circuit Breaker?

Naive fail-open means every Redis error still triggers another Redis attempt. The circuit breaker tracks consecutive failures. After `circuitBreakerThreshold` failures it opens: subsequent requests skip Redis and fail-open instantly. After `circuitBreakerResetMs` it allows one half-open probe. Use `getStatus()` to expose this in your health endpoint.

### Production checklist

- Own the Redis client lifecycle and configure auth, TLS, retries, and timeouts.
- Prefer `limiter.check({ key, tier })` after authenticating the client.
- Use a stable key: client ID, API key ID, user ID, or trusted IP.
- Never let public clients directly choose their tier.
- Keep `hashKeys: true` in production.
- Wire `onLimitReached` and `onError` into metrics or alerts.
- Treat `result.status === "fail-open"` as a degradation signal.
- Monitor `limiter.getStatus()` in your health endpoint.
- Load test your exact tier values.

---

## Running the example

```bash
docker run -p 6379:6379 redis:7-alpine
REDIS_PASSWORD=secret bun run example/server.ts

# Test the demo tiers
curl -H "x-api-key: free-demo-key" http://localhost:1707/api/data
curl -H "x-api-key: pro-demo-key" http://localhost:1707/api/data
curl -H "x-api-key: strict-demo-key" http://localhost:1707/api/data

# Loop until the free tier is limited
for i in $(seq 1 25); do
  curl -s -o /dev/null -w "Request $i: %{http_code}\n" \
    -H "x-api-key: free-demo-key" \
    http://localhost:1707/api/data
done
```

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and guidelines.

## License

MIT — see [LICENSE](./LICENSE).

---

<sub>Built for production. Tested under load. No magic, no global state, no surprises.</sub>
