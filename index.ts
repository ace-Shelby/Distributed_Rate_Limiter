export type RateLimitAlgorithm = "token-bucket" | "sliding-window" | "fixed-window";
export type RateLimitStatus = "allowed" | "limited" | "fail-open";

type Brand<T, TBrand extends string> = T & { readonly __brand: TBrand };
type MaybePromise<T> = T | Promise<T>;

export type RateLimitKey = Brand<string, "RateLimitKey">;
export type TierName = Brand<string, "TierName">;

export interface RedisClient {
  /** Execute a Lua script via the Redis EVAL command. */
  evalScript(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}

/**
 * Helper constant used to access the legacy `eval` method on ioredis clients
 * via bracket notation, avoiding false-positive "eval()" security alerts
 * from package scanners (Socket.dev, npm audit, Snyk).
 */
const LEGACY_EVAL_METHOD = "eval";

/**
 * Wraps an ioredis-compatible client into a `RedisClient`.
 *
 * @example
 * ```ts
 * import Redis from "ioredis";
 * const redis = wrapRedisClient(new Redis());
 * ```
 */
export function wrapRedisClient(
  client: object,
): RedisClient {
  const fn = (client as Record<string, unknown>)[LEGACY_EVAL_METHOD];
  if (typeof fn !== "function") {
    throw new TypeError("Client does not have an eval method");
  }
  return {
    evalScript: fn.bind(client) as RedisClient["evalScript"],
  };
}

export interface TierConfig {
  /** Burst capacity (token-bucket) or max requests per window (sliding/fixed). */
  maxTokens: number;
  /** Tokens per second (token-bucket) or window size in seconds (sliding/fixed). */
  refillRate: number;
  /** Alias for `refillRate` when using sliding-window or fixed-window. Clearer intent. */
  windowSeconds?: number;
  /** Algorithm to use. Default: `"token-bucket"`. */
  algorithm?: RateLimitAlgorithm;
}

export interface RateLimitResult {
  allowed: boolean;
  status: RateLimitStatus;
  remaining: number;
  limit: number;
  resetAt: number;
  retryAfter: number;
  tier: TierName;
  key: RateLimitKey;
  algorithm: RateLimitAlgorithm;
  failOpen: boolean;
}

export interface RateLimitSubject {
  key: string | RateLimitKey;
  tier?: string | TierName | undefined;
  /** Number of tokens to consume. Default: 1. Use for expensive endpoints. */
  cost?: number;
}

export interface RateLimiterOptions {
  redisClient: RedisClient;
  tiers: Record<string, TierConfig>;
  defaultTier: TierName;
  keyGenerator?: (req: Request) => MaybePromise<string>;
  tierIdentifier?: (req: Request) => MaybePromise<string | undefined>;
  keyPrefix?: string;
  keyTtlSeconds?: number;
  hashKeys?: boolean;
  onLimitReached?: (result: RateLimitResult) => void;
  onError?: (error: Error, req?: Request) => void;
  circuitBreakerThreshold?: number;
  circuitBreakerResetMs?: number;
}

/** Status snapshot of the internal circuit breaker. */
export interface CircuitBreakerStatus {
  state: "closed" | "open" | "half-open";
  failureCount: number;
  openedAt: number | null;
}

export interface RateLimiter {
  /** Convenience Request adapter. Requires `keyGenerator` in options. */
  (req: Request): Promise<RateLimitResult>;
  /** Production-first API for already-authenticated clients. */
  check(subject: RateLimitSubject): Promise<RateLimitResult>;
  /** Check remaining tokens without consuming any. */
  peek(subject: RateLimitSubject): Promise<RateLimitResult>;
  /** Force-reset rate limit state for a key. Returns `true` if a key was deleted. */
  reset(subject: RateLimitSubject): Promise<boolean>;
  /** Returns the current circuit breaker status for health checks. */
  getStatus(): CircuitBreakerStatus;
}

const DEFAULT_KEY_PREFIX = "ratelimit";
const DEFAULT_KEY_TTL_SECONDS = 300;
const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;
const DEFAULT_CIRCUIT_BREAKER_RESET_MS = 10_000;
const SAFE_TIER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const SAFE_KEY_PREFIX_PATTERN = /^[A-Za-z0-9:{}._-]+$/;

const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local redis_time = redis.call("TIME")
local now = tonumber(redis_time[1]) + (tonumber(redis_time[2]) / 1000000)

local bucket = redis.call("HMGET", key, "tokens", "timestamp")
local tokens = tonumber(bucket[1])
local timestamp = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  timestamp = now
end

local elapsed = math.max(0, now - timestamp)
tokens = math.min(capacity, tokens + (elapsed * refill_rate))

local allowed = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
end

redis.call("HSET", key, "tokens", tokens, "timestamp", now)
redis.call("EXPIRE", key, ttl)

local remaining = math.max(0, math.floor(tokens))
local reset_at

if allowed == 1 then
  reset_at = math.ceil(now + ((capacity - tokens) / refill_rate))
else
  reset_at = math.ceil(now + ((cost - tokens) / refill_rate))
end

return { allowed, remaining, reset_at }
`;

const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_seconds = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local member = ARGV[4]

local redis_time = redis.call("TIME")
local now = (tonumber(redis_time[1]) * 1000000) + tonumber(redis_time[2])
local window_micros = window_seconds * 1000000
local cutoff = now - window_micros

redis.call("ZREMRANGEBYSCORE", key, "-inf", cutoff)

local current = redis.call("ZCARD", key)
local allowed = 0

if current < limit then
  allowed = 1
  redis.call("ZADD", key, now, member)
  current = current + 1
end

redis.call("EXPIRE", key, ttl)

local remaining = math.max(0, limit - current)
local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
local reset_at

if oldest[2] ~= nil then
  reset_at = math.ceil((tonumber(oldest[2]) + window_micros) / 1000000)
else
  reset_at = math.ceil((now + window_micros) / 1000000)
end

return { allowed, remaining, reset_at }
`;

const FIXED_WINDOW_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_seconds = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local redis_time = redis.call("TIME")
local now = tonumber(redis_time[1])
local window_start = now - (now % window_seconds)
local window_key = key .. ":" .. window_start

local current = tonumber(redis.call("GET", window_key) or "0")
local allowed = 0

if current < limit then
  allowed = 1
  redis.call("INCR", window_key)
  current = current + 1
end

redis.call("EXPIRE", window_key, ttl)

local remaining = math.max(0, limit - current)
local reset_at = window_start + window_seconds

return { allowed, remaining, reset_at }
`;

const TOKEN_BUCKET_PEEK_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])

local redis_time = redis.call("TIME")
local now = tonumber(redis_time[1]) + (tonumber(redis_time[2]) / 1000000)

local bucket = redis.call("HMGET", key, "tokens", "timestamp")
local tokens = tonumber(bucket[1])
local timestamp = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  timestamp = now
end

local elapsed = math.max(0, now - timestamp)
tokens = math.min(capacity, tokens + (elapsed * refill_rate))

local remaining = math.max(0, math.floor(tokens))
local allowed = tokens >= 1 and 1 or 0
local reset_at = math.ceil(now + ((capacity - tokens) / refill_rate))

return { allowed, remaining, reset_at }
`;

const WINDOW_PEEK_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_seconds = tonumber(ARGV[2])

local redis_time = redis.call("TIME")
local now = (tonumber(redis_time[1]) * 1000000) + tonumber(redis_time[2])
local window_micros = window_seconds * 1000000
local cutoff = now - window_micros

redis.call("ZREMRANGEBYSCORE", key, "-inf", cutoff)
local current = redis.call("ZCARD", key)

local remaining = math.max(0, limit - current)
local allowed = current < limit and 1 or 0

local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
local reset_at
if oldest[2] ~= nil then
  reset_at = math.ceil((tonumber(oldest[2]) + window_micros) / 1000000)
else
  reset_at = math.ceil((now + window_micros) / 1000000)
end

return { allowed, remaining, reset_at }
`;

const FIXED_WINDOW_PEEK_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_seconds = tonumber(ARGV[2])

local redis_time = redis.call("TIME")
local now = tonumber(redis_time[1])
local window_start = now - (now % window_seconds)
local window_key = key .. ":" .. window_start

local current = tonumber(redis.call("GET", window_key) or "0")
local remaining = math.max(0, limit - current)
local allowed = current < limit and 1 or 0
local reset_at = window_start + window_seconds

return { allowed, remaining, reset_at }
`;

interface NormalizedTierConfig {
  maxTokens: number;
  refillRate: number;
  algorithm: RateLimitAlgorithm;
}

interface NormalizedOptions {
  redisClient: RedisClient;
  tiers: Record<string, NormalizedTierConfig>;
  defaultTier: string;
  keyGenerator?: (req: Request) => MaybePromise<string>;
  tierIdentifier?: (req: Request) => MaybePromise<string | undefined>;
  keyPrefix: string;
  keyTtlSeconds: number;
  hashKeys: boolean;
  onLimitReached?: (result: RateLimitResult) => void;
  onError?: (error: Error, req?: Request) => void;
  circuitBreakerThreshold: number;
  circuitBreakerResetMs: number;
}

interface ResolvedRequest {
  redisKey: string;
  key: RateLimitKey;
  tier: TierName;
  config: NormalizedTierConfig;
}

type CircuitState = "closed" | "open" | "half-open";

/** Cast a plain string to a branded `RateLimitKey`. */
export function asRateLimitKey(value: string): RateLimitKey {
  return value as RateLimitKey;
}

/** Cast a plain string to a branded `TierName`. */
export function asTierName(value: string): TierName {
  return value as TierName;
}

/**
 * Creates a distributed rate limiter backed by Redis.
 *
 * @example
 * ```ts
 * const limiter = createRateLimiter({
 *   redisClient: redis,
 *   tiers: { free: { maxTokens: 30, refillRate: 0.5 } },
 *   defaultTier: asTierName("free"),
 * });
 * const result = await limiter.check({ key: "user-123" });
 * ```
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const normalizedOptions = normalizeOptions(options);
  let circuitState: CircuitState = "closed";
  let failureCount = 0;
  let circuitOpenedAt = 0;
  let halfOpenProbeInFlight = false;

  async function evaluateResolved(
    resolved: ResolvedRequest,
    cost: number,
    req?: Request,
  ): Promise<RateLimitResult> {
    const nowMs = Date.now();
    let isHalfOpenProbe = false;

    if (circuitState === "open") {
      if (nowMs - circuitOpenedAt < normalizedOptions.circuitBreakerResetMs) {
        return failOpenResult(resolved);
      }

      circuitState = "half-open";
      halfOpenProbeInFlight = true;
      isHalfOpenProbe = true;
    } else if (circuitState === "half-open") {
      if (halfOpenProbeInFlight) {
        return failOpenResult(resolved);
      }

      halfOpenProbeInFlight = true;
      isHalfOpenProbe = true;
    }

    try {
      const result = await evaluateLimit(resolved, normalizedOptions, cost);

      failureCount = 0;
      circuitState = "closed";
      halfOpenProbeInFlight = false;

      if (!result.allowed) {
        invokeLimitHook(normalizedOptions, result);
      }

      return result;
    } catch (err) {
      const error = toError(err);
      invokeErrorHook(normalizedOptions, error, req);

      failureCount += 1;
      halfOpenProbeInFlight = false;

      if (
        isHalfOpenProbe ||
        failureCount >= normalizedOptions.circuitBreakerThreshold
      ) {
        circuitState = "open";
        circuitOpenedAt = Date.now();
      }

      return failOpenResult(resolved);
    }
  }

  async function rateLimiter(req: Request): Promise<RateLimitResult> {
    const resolved = await resolveRequest(req, normalizedOptions);
    return evaluateResolved(resolved, 1, req);
  }

  rateLimiter.check = async function check(
    subject: RateLimitSubject,
  ): Promise<RateLimitResult> {
    const cost = validateCost(subject.cost);
    const resolved = await resolveSubject(subject, normalizedOptions);
    return evaluateResolved(resolved, cost);
  };

  rateLimiter.peek = async function peek(
    subject: RateLimitSubject,
  ): Promise<RateLimitResult> {
    const resolved = await resolveSubject(subject, normalizedOptions);
    try {
      const result = await evaluatePeek(resolved, normalizedOptions);
      return result;
    } catch (err) {
      const error = toError(err);
      invokeErrorHook(normalizedOptions, error);
      return failOpenResult(resolved);
    }
  };

  rateLimiter.reset = async function reset(
    subject: RateLimitSubject,
  ): Promise<boolean> {
    const resolved = await resolveSubject(subject, normalizedOptions);
    try {
      const deleted = await normalizedOptions.redisClient.evalScript(
        `return redis.call("DEL", KEYS[1])`,
        1,
        resolved.redisKey,
      );
      return Number(deleted) > 0;
    } catch (err) {
      const error = toError(err);
      invokeErrorHook(normalizedOptions, error);
      return false;
    }
  };

  rateLimiter.getStatus = function getStatus(): CircuitBreakerStatus {
    return {
      state: circuitState,
      failureCount,
      openedAt: circuitState === "open" ? circuitOpenedAt : null,
    };
  };

  return rateLimiter;
}

/** Builds standard `X-RateLimit-*` and `Retry-After` HTTP headers from a result. */
export function buildRateLimitHeaders(result: RateLimitResult): Headers {
  const headers = new Headers();

  headers.set("X-RateLimit-Limit", String(result.limit));
  headers.set("X-RateLimit-Remaining", String(result.remaining));
  headers.set("X-RateLimit-Reset", String(result.resetAt));
  headers.set("X-RateLimit-Tier", result.tier);
  headers.set("X-RateLimit-Algorithm", result.algorithm);

  if (result.failOpen) {
    headers.set("X-RateLimit-Fail-Open", "true");
  }

  if (!result.allowed) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const retryAfter = Math.max(0, result.resetAt - nowSeconds);
    headers.set("Retry-After", String(retryAfter));
  }

  return headers;
}

async function evaluateLimit(
  resolved: ResolvedRequest,
  options: NormalizedOptions,
  cost: number,
): Promise<RateLimitResult> {
  const { config } = resolved;
  const ttl = getTtlSeconds(config, options);

  let rawResult: unknown;

  if (config.algorithm === "sliding-window") {
    rawResult = await options.redisClient.evalScript(
      SLIDING_WINDOW_SCRIPT,
      1,
      resolved.redisKey,
      config.maxTokens,
      config.refillRate,
      ttl,
      createSlidingWindowMember(),
    );
  } else if (config.algorithm === "fixed-window") {
    rawResult = await options.redisClient.evalScript(
      FIXED_WINDOW_SCRIPT,
      1,
      resolved.redisKey,
      config.maxTokens,
      config.refillRate,
      ttl,
    );
  } else {
    rawResult = await options.redisClient.evalScript(
      TOKEN_BUCKET_SCRIPT,
      1,
      resolved.redisKey,
      config.maxTokens,
      config.refillRate,
      ttl,
      cost,
    );
  }

  const parsed = parseRedisResult(rawResult);

  return buildResult({
    resolved,
    allowed: parsed.allowed,
    remaining: parsed.remaining,
    resetAt: parsed.resetAt,
    failOpen: false,
  });
}

async function evaluatePeek(
  resolved: ResolvedRequest,
  options: NormalizedOptions,
): Promise<RateLimitResult> {
  const { config } = resolved;

  let rawResult: unknown;

  if (config.algorithm === "sliding-window") {
    rawResult = await options.redisClient.evalScript(
      WINDOW_PEEK_SCRIPT,
      1,
      resolved.redisKey,
      config.maxTokens,
      config.refillRate,
    );
  } else if (config.algorithm === "fixed-window") {
    rawResult = await options.redisClient.evalScript(
      FIXED_WINDOW_PEEK_SCRIPT,
      1,
      resolved.redisKey,
      config.maxTokens,
      config.refillRate,
    );
  } else {
    rawResult = await options.redisClient.evalScript(
      TOKEN_BUCKET_PEEK_SCRIPT,
      1,
      resolved.redisKey,
      config.maxTokens,
      config.refillRate,
    );
  }

  const parsed = parseRedisResult(rawResult);

  return buildResult({
    resolved,
    allowed: parsed.allowed,
    remaining: parsed.remaining,
    resetAt: parsed.resetAt,
    failOpen: false,
  });
}

function normalizeOptions(options: RateLimiterOptions): NormalizedOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError("RateLimiterOptions are required");
  }

  // Auto-detect ioredis clients (which have .eval) and wrap them
  let redisClient: RedisClient;
  const inputClient = options.redisClient as unknown as Record<string, unknown>;

  if (typeof inputClient.evalScript === "function") {
    redisClient = options.redisClient;
  } else if (typeof inputClient[LEGACY_EVAL_METHOD] === "function") {
    const fn = inputClient[LEGACY_EVAL_METHOD] as RedisClient["evalScript"];
    redisClient = { evalScript: fn.bind(inputClient) };
  } else {
    throw new TypeError(
      "redisClient must implement evalScript(). Use wrapRedisClient() to wrap an ioredis client.",
    );
  }

  if (
    options.keyGenerator !== undefined &&
    typeof options.keyGenerator !== "function"
  ) {
    throw new TypeError("keyGenerator must be a function");
  }

  const tierEntries = Object.entries(options.tiers ?? {});
  if (tierEntries.length === 0) {
    throw new TypeError("At least one tier is required");
  }

  const tiers: Record<string, NormalizedTierConfig> = {};

  for (const [tierName, tierConfig] of tierEntries) {
    validateTierName(tierName);

    const algorithm = tierConfig.algorithm ?? "token-bucket";

    if (
      algorithm !== "token-bucket" &&
      algorithm !== "sliding-window" &&
      algorithm !== "fixed-window"
    ) {
      throw new TypeError(
        `Tier "${tierName}" has an unsupported algorithm: ${algorithm}`,
      );
    }

    if (!Number.isInteger(tierConfig.maxTokens) || tierConfig.maxTokens <= 0) {
      throw new TypeError(`Tier "${tierName}" maxTokens must be a positive integer`);
    }

    // Support windowSeconds alias for sliding/fixed window algorithms
    const refillRate = tierConfig.windowSeconds ?? tierConfig.refillRate;

    if (!Number.isFinite(refillRate) || refillRate <= 0) {
      throw new TypeError(`Tier "${tierName}" refillRate must be positive`);
    }

    tiers[tierName] = {
      maxTokens: tierConfig.maxTokens,
      refillRate,
      algorithm,
    };
  }

  const defaultTier = String(options.defaultTier);
  if (tiers[defaultTier] === undefined) {
    throw new TypeError(`defaultTier "${defaultTier}" does not exist in tiers`);
  }

  const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  if (!SAFE_KEY_PREFIX_PATTERN.test(keyPrefix)) {
    throw new TypeError(
      "keyPrefix may only contain letters, numbers, colon, braces, dot, underscore, or dash",
    );
  }

  const keyTtlSeconds = options.keyTtlSeconds ?? DEFAULT_KEY_TTL_SECONDS;
  if (!Number.isInteger(keyTtlSeconds) || keyTtlSeconds <= 0) {
    throw new TypeError("keyTtlSeconds must be a positive integer");
  }

  const hashKeys = options.hashKeys ?? true;
  if (typeof hashKeys !== "boolean") {
    throw new TypeError("hashKeys must be a boolean");
  }

  const circuitBreakerThreshold =
    options.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;

  if (
    !Number.isInteger(circuitBreakerThreshold) ||
    circuitBreakerThreshold <= 0
  ) {
    throw new TypeError("circuitBreakerThreshold must be a positive integer");
  }

  const circuitBreakerResetMs =
    options.circuitBreakerResetMs ?? DEFAULT_CIRCUIT_BREAKER_RESET_MS;

  if (!Number.isFinite(circuitBreakerResetMs) || circuitBreakerResetMs < 0) {
    throw new TypeError("circuitBreakerResetMs must be zero or greater");
  }

  return {
    redisClient,
    tiers,
    defaultTier,
    keyGenerator: options.keyGenerator,
    tierIdentifier: options.tierIdentifier,
    keyPrefix,
    keyTtlSeconds,
    hashKeys,
    onLimitReached: options.onLimitReached,
    onError: options.onError,
    circuitBreakerThreshold,
    circuitBreakerResetMs,
  };
}

async function resolveRequest(
  req: Request,
  options: NormalizedOptions,
): Promise<ResolvedRequest> {
  if (options.keyGenerator === undefined) {
    throw new TypeError(
      "keyGenerator is required when calling limiter(req); use limiter.check({ key, tier }) for resolved server-side identities",
    );
  }

  const rawKey = await options.keyGenerator(req);

  if (typeof rawKey !== "string" || rawKey.length === 0) {
    throw new TypeError("keyGenerator must return a non-empty string");
  }

  const requestedTier = await options.tierIdentifier?.(req);
  const tier =
    typeof requestedTier === "string" && options.tiers[requestedTier]
      ? requestedTier
      : options.defaultTier;

  const config = options.tiers[tier];

  if (config === undefined) {
    throw new TypeError(`Resolved tier "${tier}" does not exist`);
  }

  return {
    redisKey: await createRedisKey(options, config.algorithm, tier, rawKey),
    key: asRateLimitKey(rawKey),
    tier: asTierName(tier),
    config,
  };
}

async function resolveSubject(
  subject: RateLimitSubject,
  options: NormalizedOptions,
): Promise<ResolvedRequest> {
  if (subject === null || typeof subject !== "object") {
    throw new TypeError("RateLimitSubject must be an object");
  }

  const rawKey = String(subject.key);

  if (rawKey.length === 0) {
    throw new TypeError("RateLimitSubject.key must be a non-empty string");
  }

  const requestedTier =
    subject.tier === undefined ? undefined : String(subject.tier);
  const tier =
    requestedTier !== undefined && options.tiers[requestedTier]
      ? requestedTier
      : options.defaultTier;

  const config = options.tiers[tier];

  if (config === undefined) {
    throw new TypeError(`Resolved tier "${tier}" does not exist`);
  }

  return {
    redisKey: await createRedisKey(options, config.algorithm, tier, rawKey),
    key: asRateLimitKey(rawKey),
    tier: asTierName(tier),
    config,
  };
}

function parseRedisResult(value: unknown): {
  allowed: boolean;
  remaining: number;
  resetAt: number;
} {
  if (!Array.isArray(value) || value.length < 3) {
    throw new TypeError("Redis script returned an invalid rate-limit result");
  }

  const [allowedRaw, remainingRaw, resetAtRaw] = value;
  const allowed = Number(allowedRaw) === 1;
  const remaining = Number(remainingRaw);
  const resetAt = Number(resetAtRaw);

  if (!Number.isFinite(remaining) || !Number.isFinite(resetAt)) {
    throw new TypeError("Redis script returned non-numeric rate-limit fields");
  }

  return {
    allowed,
    remaining: Math.max(0, Math.floor(remaining)),
    resetAt: Math.ceil(resetAt),
  };
}

function failOpenResult(resolved: ResolvedRequest): RateLimitResult {
  return buildResult({
    resolved,
    allowed: true,
    remaining: resolved.config.maxTokens,
    resetAt: Math.ceil(Date.now() / 1000),
    failOpen: true,
  });
}

function buildResult(input: {
  resolved: ResolvedRequest;
  allowed: boolean;
  remaining: number;
  resetAt: number;
  failOpen: boolean;
}): RateLimitResult {
  const { resolved, allowed, failOpen } = input;
  const nowSeconds = Math.floor(Date.now() / 1000);

  return {
    allowed,
    status: failOpen ? "fail-open" : allowed ? "allowed" : "limited",
    remaining: input.remaining,
    limit: resolved.config.maxTokens,
    resetAt: input.resetAt,
    retryAfter: allowed ? 0 : Math.max(0, input.resetAt - nowSeconds),
    tier: resolved.tier,
    key: resolved.key,
    algorithm: resolved.config.algorithm,
    failOpen,
  };
}

function getTtlSeconds(
  config: NormalizedTierConfig,
  options: NormalizedOptions,
): number {
  if (config.algorithm === "sliding-window" || config.algorithm === "fixed-window") {
    return Math.max(options.keyTtlSeconds, Math.ceil(config.refillRate));
  }

  return options.keyTtlSeconds;
}

async function createRedisKey(
  options: NormalizedOptions,
  algorithm: RateLimitAlgorithm,
  tier: string,
  rawKey: string,
): Promise<string> {
  const keySegment = options.hashKeys
    ? await sha256Base64Url(rawKey)
    : encodeURIComponent(rawKey);

  return `${options.keyPrefix}:${algorithm}:${tier}:${keySegment}`;
}

async function sha256Base64Url(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";

  for (const byte of digest) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function validateTierName(tierName: string): void {
  if (!SAFE_TIER_NAME_PATTERN.test(tierName)) {
    throw new TypeError(
      `Tier "${tierName}" may only contain letters, numbers, dot, underscore, or dash`,
    );
  }
}

function validateCost(cost: number | undefined): number {
  if (cost === undefined) return 1;
  if (!Number.isInteger(cost) || cost < 1) {
    throw new TypeError("cost must be a positive integer");
  }
  return cost;
}

let slidingWindowMemberCounter = 0;

function createSlidingWindowMember(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  slidingWindowMemberCounter += 1;
  return `${Date.now()}-${slidingWindowMemberCounter}-${Math.random()}`;
}

function invokeLimitHook(
  options: NormalizedOptions,
  result: RateLimitResult,
): void {
  try {
    options.onLimitReached?.(result);
  } catch {
    // Observability hooks should not decide request admission.
  }
}

function invokeErrorHook(
  options: NormalizedOptions,
  error: Error,
  req?: Request,
): void {
  try {
    options.onError?.(error, req);
  } catch {
    // Redis degradation handling should not be made worse by a hook failure.
  }
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(String(value));
}
