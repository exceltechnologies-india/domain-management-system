/**
 * Tests for `@/lib/audit-log` (rescan-4 slice 7ee).
 * Admin-action audit logger + query/stats helpers. Pins:
 *  - logAdminAction never throws: a DB-write failure logs the error but
 *    does NOT bubble to the request handler (logging MUST NOT break
 *    application flow)
 *  - logAPIRequest derives a structured action from path + method
 *    ("GET /users/list" → "VIEW_LIST", DELETE → "DELETE_X")
 *  - **request body sanitization**: 9 sensitive field names redacted
 *    to "[REDACTED]" before insert (password / token / secret / apiKey
 *    / accessToken / refreshToken / creditCard / cvv / ssn)
 *  - getClientIP precedence: x-forwarded-for (first comma-split) >
 *    x-real-ip > request.ip > "unknown"
 *  - logAPIRequest's success flag = responseStatus < 400
 *  - logAPIRequest auto-fills `error: "HTTP 500"` when status >= 400
 *    and no explicit error supplied (saves callers from doing it)
 *  - queryAuditLogs builds {userId?, action?, ip?, createdAt:{$gte,$lte}}
 *    filter; default limit 100; sort createdAt:-1; lean
 *  - queryAuditLogs DB throw → returns [] (never bubbles)
 *  - getAuditStats aggregates: actionsByType counts, actionsByDay sorted
 *    chronologically, topIPs top-10 desc, errorRate=errors/total*100
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const create = vi.hoisted(() => vi.fn());
const find = vi.hoisted(() => vi.fn());
vi.mock("mongoose", async () => {
  const actual = await vi.importActual<typeof import("mongoose")>("mongoose");
  return {
    ...actual,
    default: {
      ...actual.default,
      Schema: actual.default.Schema,
      Types: actual.default.Types,
      model: () => ({ create, find }),
      models: {},
    },
    Schema: actual.default.Schema,
    Types: actual.default.Types,
  };
});

import { logAdminAction, logAPIRequest, queryAuditLogs, getAuditStats } from "@/lib/audit-log";

beforeEach(() => {
  connectDB.mockReset();
  create.mockReset();
  find.mockReset();
});

function mockNextRequest(opts: {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  searchParams?: Record<string, string>;
  ip?: string;
}) {
  const h = new Headers(opts.headers ?? {});
  const search = new URLSearchParams(opts.searchParams ?? {});
  const req: Record<string, unknown> = {
    method: opts.method ?? "GET",
    headers: h,
    nextUrl: {
      pathname: opts.path,
      searchParams: search,
    },
    ip: opts.ip,
    clone() {
      return {
        json: async () => opts.body ?? null,
      };
    },
  };
  return req;
}

describe("logAdminAction", () => {
  it("inserts the entry via AuditLog.create", async () => {
    create.mockResolvedValueOnce({});
    await logAdminAction({
      userId: "u1",
      userEmail: "u@x.test",
      action: "VIEW_USERS",
      resource: "/api/users",
      method: "GET",
      path: "/api/users",
      ip: "1.2.3.4",
    });
    expect(connectDB).toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("DB throw is logged + swallowed — never crashes the caller", async () => {
    create.mockRejectedValueOnce(new Error("write failed"));
    await expect(
      logAdminAction({
        userId: "u",
        userEmail: "e",
        action: "X",
        resource: "/r",
        method: "GET",
        path: "/r",
        ip: "1",
      })
    ).resolves.toBeUndefined();
  });
});

describe("logAPIRequest — action derivation + sanitization", () => {
  it("GET /admin/users/list → action='VIEW_LIST' (METHOD_RESOURCE form)", async () => {
    create.mockResolvedValueOnce({});
    const req = mockNextRequest({ path: "/admin/users/list", method: "GET" });
    await logAPIRequest(req as never, { id: "u1", email: "u@x.test" }, 200, 5);
    const [entry] = create.mock.calls[0];
    expect(entry.action).toBe("VIEW_LIST");
    expect(entry.method).toBe("GET");
    expect(entry.success).toBe(true);
  });

  it("POST/PUT/PATCH/DELETE map to CREATE/UPDATE/UPDATE/DELETE", async () => {
    create.mockReset();
    const methods = [
      ["POST", "CREATE"],
      ["PUT", "UPDATE"],
      ["PATCH", "UPDATE"],
      ["DELETE", "DELETE"],
    ];
    for (const [method, expected] of methods) {
      create.mockResolvedValueOnce({});
      await logAPIRequest(
        mockNextRequest({ path: "/x/y", method }) as never,
        { id: "u1", email: "u@x.test" },
        200,
        1
      );
    }
    methods.forEach(([, expected], i) => {
      expect(create.mock.calls[i][0].action).toBe(`${expected}_Y`);
    });
  });

  it("status >= 400 → success:false + auto-fills error='HTTP 500'", async () => {
    create.mockResolvedValueOnce({});
    await logAPIRequest(
      mockNextRequest({ path: "/r", method: "POST" }) as never,
      { id: "u1", email: "u@x.test" },
      500,
      5
    );
    const [entry] = create.mock.calls[0];
    expect(entry.success).toBe(false);
    expect(entry.error).toBe("HTTP 500");
  });

  it("explicit error arg wins over the HTTP-status auto-fill", async () => {
    create.mockResolvedValueOnce({});
    await logAPIRequest(
      mockNextRequest({ path: "/r", method: "POST" }) as never,
      { id: "u1", email: "u@x.test" },
      500,
      5,
      "custom failure"
    );
    expect(create.mock.calls[0][0].error).toBe("custom failure");
  });

  it("request body sanitization: ALL 9 sensitive fields → '[REDACTED]'", async () => {
    create.mockResolvedValueOnce({});
    const body = {
      username: "alice",
      password: "p4ss",
      token: "t",
      secret: "s",
      apiKey: "k",
      accessToken: "a",
      refreshToken: "r",
      creditCard: "4242",
      cvv: "123",
      ssn: "111-22-3333",
      keepMe: "yes",
    };
    await logAPIRequest(
      mockNextRequest({ path: "/r", method: "POST", body }) as never,
      { id: "u1", email: "u@x.test" },
      200,
      1
    );
    const entry = create.mock.calls[0][0];
    expect(entry.requestBody.password).toBe("[REDACTED]");
    expect(entry.requestBody.token).toBe("[REDACTED]");
    expect(entry.requestBody.secret).toBe("[REDACTED]");
    expect(entry.requestBody.apiKey).toBe("[REDACTED]");
    expect(entry.requestBody.accessToken).toBe("[REDACTED]");
    expect(entry.requestBody.refreshToken).toBe("[REDACTED]");
    expect(entry.requestBody.creditCard).toBe("[REDACTED]");
    expect(entry.requestBody.cvv).toBe("[REDACTED]");
    expect(entry.requestBody.ssn).toBe("[REDACTED]");
    // Non-sensitive fields preserved.
    expect(entry.requestBody.username).toBe("alice");
    expect(entry.requestBody.keepMe).toBe("yes");
  });

  it("getClientIP precedence: x-forwarded-for (first split) > x-real-ip > .ip > 'unknown'", async () => {
    create.mockReset();
    // 1. x-forwarded-for wins, takes first IP
    create.mockResolvedValueOnce({});
    await logAPIRequest(
      mockNextRequest({
        path: "/r",
        headers: {
          "x-forwarded-for": "1.1.1.1, 2.2.2.2",
          "x-real-ip": "3.3.3.3",
        },
        ip: "4.4.4.4",
      }) as never,
      { id: "u1", email: "u@x.test" },
      200,
      1
    );
    expect(create.mock.calls[0][0].ip).toBe("1.1.1.1");

    // 2. x-real-ip when no forwarded
    create.mockResolvedValueOnce({});
    await logAPIRequest(
      mockNextRequest({
        path: "/r",
        headers: { "x-real-ip": "3.3.3.3" },
      }) as never,
      { id: "u1", email: "u@x.test" },
      200,
      1
    );
    expect(create.mock.calls[1][0].ip).toBe("3.3.3.3");

    // 3. final fallback 'unknown'
    create.mockResolvedValueOnce({});
    await logAPIRequest(
      mockNextRequest({ path: "/r" }) as never,
      { id: "u1", email: "u@x.test" },
      200,
      1
    );
    expect(create.mock.calls[2][0].ip).toBe("unknown");
  });

  it("user.id missing falls back to _id.toString(); both missing → 'unknown'", async () => {
    create.mockReset();
    create.mockResolvedValueOnce({});
    await logAPIRequest(
      mockNextRequest({ path: "/r" }) as never,
      { _id: { toString: () => "_ID_64" }, email: "u@x.test" },
      200,
      1
    );
    expect(create.mock.calls[0][0].userId).toBe("_ID_64");

    create.mockResolvedValueOnce({});
    await logAPIRequest(
      mockNextRequest({ path: "/r" }) as never,
      { email: "u@x.test" },
      200,
      1
    );
    expect(create.mock.calls[1][0].userId).toBe("unknown");
  });
});

describe("queryAuditLogs", () => {
  function makeChain(result: unknown) {
    return {
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(result),
    };
  }

  it("no filters: empty query, sort createdAt:-1, default limit 100", async () => {
    const chain = makeChain([{ action: "X" }]);
    find.mockReturnValue(chain);
    const result = await queryAuditLogs({});
    expect(find).toHaveBeenCalledWith({});
    expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(chain.limit).toHaveBeenCalledWith(100);
    expect(chain.skip).toHaveBeenCalledWith(0);
    expect(result).toEqual([{ action: "X" }]);
  });

  it("startDate/endDate build a createdAt range", async () => {
    const chain = makeChain([]);
    find.mockReturnValue(chain);
    const start = new Date("2026-01-01");
    const end = new Date("2026-02-01");
    await queryAuditLogs({ startDate: start, endDate: end, action: "VIEW" });
    const [query] = find.mock.calls[0];
    expect(query.action).toBe("VIEW");
    expect(query.createdAt).toEqual({ $gte: start, $lte: end });
  });

  it("DB throw → returns [] (never bubbles)", async () => {
    find.mockImplementation(() => {
      throw new Error("connection lost");
    });
    expect(await queryAuditLogs({})).toEqual([]);
  });
});

describe("getAuditStats", () => {
  it("aggregates actionsByType + topIPs (desc, top-10) + errorRate", async () => {
    const logs = [
      { action: "VIEW", ip: "1", success: true, createdAt: new Date("2026-01-01") },
      { action: "VIEW", ip: "1", success: false, createdAt: new Date("2026-01-01") },
      { action: "UPDATE", ip: "2", success: true, createdAt: new Date("2026-01-02") },
    ];
    find.mockReturnValue({ lean: () => Promise.resolve(logs) });
    const stats = await getAuditStats();
    expect(stats.totalActions).toBe(3);
    expect(stats.actionsByType.VIEW).toBe(2);
    expect(stats.actionsByType.UPDATE).toBe(1);
    expect(stats.topIPs[0]).toEqual({ ip: "1", count: 2 });
    expect(stats.errorRate).toBeCloseTo((1 / 3) * 100);
    // Days sorted ascending.
    expect(stats.actionsByDay.map((d) => d.date)).toEqual([
      "2026-01-01",
      "2026-01-02",
    ]);
  });

  it("empty result → errorRate is 0 (no NaN — divide-by-zero guard)", async () => {
    find.mockReturnValue({ lean: () => Promise.resolve([]) });
    const stats = await getAuditStats();
    expect(stats.errorRate).toBe(0);
    expect(stats.totalActions).toBe(0);
  });

  it("DB throw → returns the zero-shape object (never bubbles)", async () => {
    find.mockImplementation(() => {
      throw new Error("conn");
    });
    const stats = await getAuditStats();
    expect(stats).toEqual({
      totalActions: 0,
      actionsByType: {},
      actionsByDay: [],
      topIPs: [],
      errorRate: 0,
    });
  });
});
