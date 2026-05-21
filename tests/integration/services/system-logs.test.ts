/**
 * Service-layer integration tests for lib/services/system-logs.ts.
 *
 * `recordSystemLog` defaults `level` to "error" and `source` to "Unknown" —
 * lock both in so a future refactor doesn't drift a setting.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { clearAllCollections } from "../setup";
import SystemLog from "@/models/SystemLog";
import { recordSystemLog } from "@/lib/services/system-logs";

beforeAll(async () => {
  expect(mongoose.connection.readyState).toBe(1);
  await SystemLog.syncIndexes();
});

beforeEach(clearAllCollections);

describe("recordSystemLog", () => {
  it("persists a row with all supplied fields", async () => {
    const log = await recordSystemLog({
      level: "warn",
      message: "test message",
      source: "client",
      url: "https://app.test/page",
      stack: "Error: x\n  at y",
      metadata: { foo: "bar" },
      service: "frontend",
      requestId: "req_123",
      statusCode: 500,
      ip: "1.2.3.4",
      user: new mongoose.Types.ObjectId(),
    });
    expect(log._id).toBeDefined();
    expect(log.level).toBe("warn");
    expect(log.message).toBe("test message");
    expect(log.source).toBe("client");
    expect(log.statusCode).toBe(500);
  });

  it("defaults level to 'error' when omitted", async () => {
    const log = await recordSystemLog({ message: "only message" });
    expect(log.level).toBe("error");
  });

  it("defaults source to 'Unknown' when omitted", async () => {
    const log = await recordSystemLog({ message: "no source" });
    expect(log.source).toBe("Unknown");
  });

  it("writes user:null when no user supplied", async () => {
    const log = await recordSystemLog({ message: "no user" });
    expect(log.user).toBeNull();
  });
});
