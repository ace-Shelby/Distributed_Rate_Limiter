# Contributing to ace-throttle

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/ace-Shelby/Distributed_Rate_Limiter.git
cd ace-throttle

# Install dependencies
bun install

# Run tests
bun test

# Type check
bun run typecheck

# Build
bun run build
```

## Making Changes

1. **Fork** the repository and create a feature branch from `main`.
2. **Write tests** for any new functionality or bug fix.
3. **Run the full check** before submitting:
   ```bash
   bun run typecheck && bun test && bun run build
   ```
4. **Submit a pull request** with a clear description of what changed and why.

## Code Style

- TypeScript strict mode is enabled.
- All public exports should have JSDoc comments.
- Lua scripts should be atomic — no multi-step Redis calls outside of `EVAL`.
- Hook callbacks (`onLimitReached`, `onError`) must never throw.

## Adding a New Algorithm

1. Write the Lua script (must be atomic, use `redis.call("TIME")` for timestamps).
2. Add a corresponding peek script (read-only variant).
3. Add the algorithm name to the `RateLimitAlgorithm` type.
4. Update `evaluateLimit()` and `evaluatePeek()` with the new branch.
5. Update `normalizeOptions()` validation.
6. Add tests.
7. Document in `README.md`.

## Running the Example

```bash
docker run -p 6379:6379 redis:7-alpine
REDIS_PASSWORD=yourpass bun run example/server.ts
```

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
