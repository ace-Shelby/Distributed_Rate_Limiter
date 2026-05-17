# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-05-17

### Added

- **`wrapRedisClient()` helper** — wraps an ioredis client into the `RedisClient` interface. Provides a clean, type-safe bridge.
- **Logo** — added `logo.png` as package/GitHub icon. README now displays it centered at the top.

### Changed

- **`RedisClient.eval()` → `RedisClient.evalScript()`** — renamed to eliminate false-positive "eval() usage" security warnings from npm/Socket.dev scanners. Backward compatible: ioredis clients passed directly are auto-detected and wrapped at runtime.
- **Example excluded from npm package** — `example/server.ts` removed from the `files` array. Still in the repo for reference.
- Example updated to use `wrapRedisClient()`.

### Fixed

- **CI workflow** — fixed broken YAML indentation for `bun-version` under `with:` block.
- **CI badge URL** — pointed to correct repo (`Distributed_Rate_Limiter` not `ace-throttle`).

---

## [1.0.0] — 2026-05-17

### Added

- **Fixed Window algorithm** — a third rate-limiting strategy using simple Redis counters aligned to time windows. Lower memory than sliding-window, no boundary spike like naive implementations.
- **`peek()` method** — check remaining tokens without consuming any. Useful for UI indicators and dashboards.
- **`reset()` method** — force-delete a key's rate-limit state. Admin tool for support workflows.
- **`getStatus()` method** — returns the circuit breaker's current state (`closed`, `open`, `half-open`), failure count, and when it opened. Wire into health check endpoints.
- **`cost` parameter** — `check({ key, tier, cost: 5 })` consumes multiple tokens in a single call. Use for expensive endpoints.
- **`windowSeconds` config alias** — clearer intent when configuring sliding-window or fixed-window tiers instead of overloading `refillRate`.
- **`CircuitBreakerStatus` export** — typed interface for the `getStatus()` return value.
- **JSDoc comments** on all public exports.
- **GitHub Actions CI** — typecheck → test → build on every push and PR.
- **CONTRIBUTING.md** with development guidelines.

### Changed

- Token Bucket Lua script now accepts a `cost` parameter (defaults to 1, backward compatible).
- Fixed-window and sliding-window TTLs now both use `Math.max(keyTtlSeconds, windowSize)`.
- `package.json` version bumped to `1.0.0`.
- Added `engines`, `repository`, `author`, `homepage`, `bugs` fields to `package.json`.
- Expanded keywords for npm discoverability.
- Pinned `@types/bun` to `^1.2.0` instead of `"latest"`.

### Fixed

- **Security**: Removed hardcoded Redis password from `example/server.ts`. Now reads from `REDIS_PASSWORD` env var.
- Removed `.env` from git tracking.

### Removed

- Nothing. This release is fully backward compatible with `0.1.0`.
