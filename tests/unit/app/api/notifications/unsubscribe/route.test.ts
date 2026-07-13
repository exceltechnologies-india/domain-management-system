/**
 * Tests for app/api/notifications/unsubscribe/route.ts.
 *  - GET is scanner-safe: NO state change; renders confirm page (or 400 on
 *    bad token).
 *  - POST performs the opt-out (default/one-click) or resubscribe.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const updateOne = vi.hoisted(() => vi.fn());
vi.mock("@/models/User", () => ({ default: { updateOne } }));

const verifyUnsubscribeToken = vi.hoisted(() => vi.fn());
vi.mock("@/lib/unsubscribe-token", () => ({ verifyUnsubscribeToken }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, POST } from "@/app/api/notifications/unsubscribe/route";

const URL_BASE = "https://app.test/api/notifications/unsubscribe";

function getReq(token: string) {
  return new NextRequest(`${URL_BASE}?token=${encodeURIComponent(token)}`);
}
function postReq(token: string, form?: Record<string, string>) {
  const body = form
    ? new URLSearchParams(form).toString()
    : "List-Unsubscribe=One-Click";
  return new NextRequest(`${URL_BASE}?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

beforeEach(() => {
  connectDB.mockReset().mockResolvedValue(undefined);
  updateOne.mockReset().mockResolvedValue({ matchedCount: 1 });
  verifyUnsubscribeToken.mockReset();
});

describe("GET (scanner-safe confirm page)", () => {
  it("invalid token → 400, no DB write", async () => {
    verifyUnsubscribeToken.mockReturnValueOnce(null);
    const res = await GET(getReq("bad"));
    expect(res.status).toBe(400);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("valid token → 200 confirm page, NO state change", async () => {
    verifyUnsubscribeToken.mockReturnValueOnce("a@x.com");
    const res = await GET(getReq("good"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("a@x.com");
    expect(html.toLowerCase()).toContain("unsubscribe");
    expect(updateOne).not.toHaveBeenCalled(); // GET must not mutate
  });
});

describe("POST", () => {
  it("one-click (no action) → sets emailOptOut=true", async () => {
    verifyUnsubscribeToken.mockReturnValueOnce("a@x.com");
    const res = await POST(postReq("good"));
    expect(res.status).toBe(200);
    expect(updateOne).toHaveBeenCalledWith(
      { email: "a@x.com" },
      { $set: { emailOptOut: true } }
    );
  });

  it("form action=resubscribe → sets emailOptOut=false", async () => {
    verifyUnsubscribeToken.mockReturnValueOnce("a@x.com");
    const res = await POST(postReq("good", { action: "resubscribe" }));
    expect(res.status).toBe(200);
    expect(updateOne).toHaveBeenCalledWith(
      { email: "a@x.com" },
      { $set: { emailOptOut: false } }
    );
  });

  it("invalid token → 400, no DB write", async () => {
    verifyUnsubscribeToken.mockReturnValueOnce(null);
    const res = await POST(postReq("bad"));
    expect(res.status).toBe(400);
    expect(updateOne).not.toHaveBeenCalled();
  });
});
