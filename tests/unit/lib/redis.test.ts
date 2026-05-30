/**
 * Tests for `@/lib/redis` (rescan-4 slice 7dk).
 * The redisCache wrapper around ioredis. Pins:
 *  - When REDIS_HOST is unset: redis is null, redisCache.get returns
 *    null, set/del are no-ops
 *  - When REDIS_HOST is set: redis is a Redis instance; get JSON-parses,
 *    set JSON-stringifies + applies TTL, del calls del
 *  - Errors in get/set/del are caught + logged; get returns null on
 *    parse failure
 *
 * `redis` is a module-load constant, so we re-import per test with
 * vi.resetModules + env stubs to flip the configured/unconfigured
 * branch. ioredis is mocked at the module level.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const RedisCtorMock = vi.hoisted(() => vi.fn());
const RedisInstance = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  on: vi.fn(),
}));
vi.mock("ioredis", () => {
  return {
    default: function (...args: unknown[]) {
      RedisCtorMock(...args);
      return RedisInstance;
    },
  };
});

const loggerError = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
const loggerInfo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: loggerError, warn: loggerWarn, info: loggerInfo },
}));

beforeEach(() => {
  vi.resetModules();
  RedisCtorMock.mockClear();
  RedisInstance.get.mockReset();
  RedisInstance.set.mockReset();
  RedisInstance.del.mockReset();
  RedisInstance.on.mockReset();
  loggerError.mockReset();
  loggerWarn.mockReset();
  loggerInfo.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("redis (unconfigured)", () => {
  it("REDIS_HOST unset → redis is null + warn log on module load", async () => {
    vi.stubEnv("REDIS_HOST", "");
    const { redis } = await import("@/lib/redis");
    expect(redis).toBeNull();
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn.mock.calls[0][0]).toMatch(/REDIS_HOST is not defined/);
  });

  it("redisCache.get returns null when redis is unconfigured", async () => {
    vi.stubEnv("REDIS_HOST", "");
    const { redisCache } = await import("@/lib/redis");
    expect(await redisCache.get("anything")).toBeNull();
    expect(RedisInstance.get).not.toHaveBeenCalled();
  });

  it("redisCache.set/del are no-ops when redis is unconfigured", async () => {
    vi.stubEnv("REDIS_HOST", "");
    const { redisCache } = await import("@/lib/redis");
    await redisCache.set("k", { a: 1 });
    await redisCache.del("k");
    expect(RedisInstance.set).not.toHaveBeenCalled();
    expect(RedisInstance.del).not.toHaveBeenCalled();
  });
});

describe("redis (configured)", () => {
  beforeEach(() => {
    vi.stubEnv("REDIS_HOST", "10.0.0.5");
    vi.stubEnv("REDIS_PORT", "6379");
  });

  it("module-load constructs Redis with the configured host/port + options", async () => {
    await import("@/lib/redis");
    expect(RedisCtorMock).toHaveBeenCalledTimes(1);
    const opts = RedisCtorMock.mock.calls[0][0];
    expect(opts.host).toBe("10.0.0.5");
    expect(opts.port).toBe(6379);
    expect(opts.lazyConnect).toBe(true);
    expect(opts.enableOfflineQueue).toBe(false);
  });

  it("redisCache.get JSON-parses the stored value", async () => {
    RedisInstance.get.mockResolvedValueOnce(JSON.stringify({ a: 1, b: "two" }));
    const { redisCache } = await import("@/lib/redis");
    const result = await redisCache.get<{ a: number; b: string }>("cache-key");
    expect(RedisInstance.get).toHaveBeenCalledWith("cache-key");
    expect(result).toEqual({ a: 1, b: "two" });
  });

  it("redisCache.get returns null when the key is missing", async () => {
    RedisInstance.get.mockResolvedValueOnce(null);
    const { redisCache } = await import("@/lib/redis");
    expect(await redisCache.get("miss")).toBeNull();
  });

  it("redisCache.get catches errors + logs (returns null)", async () => {
    RedisInstance.get.mockRejectedValueOnce(new Error("connection refused"));
    const { redisCache } = await import("@/lib/redis");
    expect(await redisCache.get("err")).toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it("redisCache.get catches JSON.parse failures + returns null", async () => {
    RedisInstance.get.mockResolvedValueOnce("not-json-{");
    const { redisCache } = await import("@/lib/redis");
    expect(await redisCache.get("bad")).toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it("redisCache.set JSON-stringifies with default 120s TTL via 'EX'", async () => {
    RedisInstance.set.mockResolvedValueOnce("OK");
    const { redisCache } = await import("@/lib/redis");
    await redisCache.set("k", { a: 1 });
    expect(RedisInstance.set).toHaveBeenCalledWith("k", '{"a":1}', "EX", 120);
  });

  it("redisCache.set respects a custom TTL in seconds", async () => {
    RedisInstance.set.mockResolvedValueOnce("OK");
    const { redisCache } = await import("@/lib/redis");
    await redisCache.set("k", "value", 3600);
    expect(RedisInstance.set).toHaveBeenCalledWith("k", '"value"', "EX", 3600);
  });

  it("redisCache.set catches errors + logs (no throw)", async () => {
    RedisInstance.set.mockRejectedValueOnce(new Error("write failed"));
    const { redisCache } = await import("@/lib/redis");
    await expect(redisCache.set("k", "v")).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it("redisCache.del calls redis.del(key)", async () => {
    RedisInstance.del.mockResolvedValueOnce(1);
    const { redisCache } = await import("@/lib/redis");
    await redisCache.del("k");
    expect(RedisInstance.del).toHaveBeenCalledWith("k");
  });

  it("redisCache.del catches errors + logs (no throw)", async () => {
    RedisInstance.del.mockRejectedValueOnce(new Error("nope"));
    const { redisCache } = await import("@/lib/redis");
    await expect(redisCache.del("k")).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledTimes(1);
  });
});
