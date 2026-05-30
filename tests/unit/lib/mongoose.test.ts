/**
 * Tests for `@/lib/mongoose` (rescan-4 slice 7dg).
 * The `connectToDatabase` wrapper is a thin alias for `connectDB` from
 * `@/lib/mongodb`. Pins the delegation contract.
 */
import { describe, it, expect, vi } from "vitest";

const connectDBMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({
  default: connectDBMock,
}));

import { connectToDatabase } from "@/lib/mongoose";

describe("connectToDatabase", () => {
  it("delegates to the default-exported connectDB", async () => {
    connectDBMock.mockResolvedValueOnce("mock-conn");
    const result = await connectToDatabase();
    expect(connectDBMock).toHaveBeenCalledTimes(1);
    expect(result).toBe("mock-conn");
  });

  it("propagates errors from the underlying connectDB", async () => {
    connectDBMock.mockRejectedValueOnce(new Error("db down"));
    await expect(connectToDatabase()).rejects.toThrow("db down");
  });
});
