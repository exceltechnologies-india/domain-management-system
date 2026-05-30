/**
 * Tests for `@/lib/mongodb` (rescan-4 slice 7dq).
 * Cached MongoDB connection used by every Mongoose-touching API route.
 * Pins:
 *  - Module-load throws when MONGODB_URI is unset
 *  - First connectDB call invokes mongoose.connect with the documented
 *    pool options (maxPoolSize:50, minPoolSize:2, waitQueueTimeoutMS:
 *    10000, etc.)
 *  - Second connectDB call returns the cached connection without re-
 *    calling mongoose.connect
 *  - Failed connect clears the cached promise so the next call retries
 *  - Cache is published on globalThis.mongoose
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const connectMock = vi.hoisted(() => vi.fn());
vi.mock("mongoose", () => ({
  default: { connect: connectMock },
}));

beforeEach(() => {
  vi.resetModules();
  connectMock.mockReset();
  // Remove the global cache between tests so each test re-runs the
  // module-load + global-cache initialisation cleanly.
  delete (globalThis as { mongoose?: unknown }).mongoose;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("connectDB (cached MongoDB connection)", () => {
  it("throws at module-load when MONGODB_URI is unset", async () => {
    vi.stubEnv("MONGODB_URI", "");
    await expect(import("@/lib/mongodb")).rejects.toThrow(/MONGODB_URI/);
  });

  it("first call invokes mongoose.connect with the documented pool options", async () => {
    vi.stubEnv("MONGODB_URI", "mongodb://localhost/test");
    connectMock.mockResolvedValueOnce({ tag: "connected" });
    const { default: connectDB } = await import("@/lib/mongodb");
    await connectDB();
    expect(connectMock).toHaveBeenCalledTimes(1);
    const [uri, opts] = connectMock.mock.calls[0];
    expect(uri).toBe("mongodb://localhost/test");
    expect(opts).toMatchObject({
      bufferCommands: false,
      maxPoolSize: 50,
      minPoolSize: 2,
      maxConnecting: 5,
      maxIdleTimeMS: 30000,
      waitQueueTimeoutMS: 10000,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
  });

  it("subsequent calls return the cached connection without re-invoking mongoose.connect", async () => {
    vi.stubEnv("MONGODB_URI", "mongodb://localhost/test");
    connectMock.mockResolvedValueOnce({ tag: "connected" });
    const { default: connectDB } = await import("@/lib/mongodb");
    const first = await connectDB();
    const second = await connectDB();
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it("failed connect clears the cached promise so the next call retries", async () => {
    vi.stubEnv("MONGODB_URI", "mongodb://localhost/test");
    connectMock
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ tag: "ok" });
    const { default: connectDB } = await import("@/lib/mongodb");
    await expect(connectDB()).rejects.toThrow("ECONNREFUSED");
    // Cached promise was cleared — second call re-runs connect.
    const second = await connectDB();
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(second).toEqual({ tag: "ok" });
  });

  it("cache is published on globalThis.mongoose (survives hot-reloads)", async () => {
    vi.stubEnv("MONGODB_URI", "mongodb://localhost/test");
    connectMock.mockResolvedValueOnce({ tag: "connected" });
    const { default: connectDB } = await import("@/lib/mongodb");
    await connectDB();
    const cached = (globalThis as { mongoose?: { conn: unknown } }).mongoose;
    expect(cached).toBeDefined();
    expect(cached?.conn).toEqual({ tag: "connected" });
  });
});
