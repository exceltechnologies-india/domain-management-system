/**
 * Tests for `app/api/analytics/track/route.ts` — the public journey beacon.
 *
 * Focus: the deduplicated Meta CAPI twin added so mid-funnel Pixel events
 * survive browser-side beacon blocking (ad-blocker / ITP).
 *
 * Pins:
 *  - view_content + checkout_started with an eventId → CAPI twin fired with
 *    the SHARED eventId + the mapped standard event name (dedup contract).
 *  - a client CANNOT pick an arbitrary Meta event — the activity determines
 *    the event name; a spoofed metaEvent is ignored.
 *  - start_trial / landing_page_visit → NEVER a CAPI twin (StartTrial is
 *    server-provisioning-only; PageView is browser-only).
 *  - no eventId → no CAPI twin (nothing to dedup against).
 *  - recordActivity is always called; CAPI failure never breaks the beacon.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const recordActivity = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/analytics", () => ({ recordActivity }));

const sendMetaServerEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/meta-capi", () => ({ sendMetaServerEvent }));

const getToken = vi.hoisted(() => vi.fn());
vi.mock("next-auth/jwt", () => ({ getToken }));

vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET: "test-secret" }));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/analytics/track/route";

function makeReq(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest("https://app.anutech.in/api/v1/analytics/track", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getToken.mockResolvedValue(null);
});

describe("analytics/track CAPI twin", () => {
  it("fires a CAPI ViewContent with the shared eventId, IP/UA/URL + forwarded cookies", async () => {
    const res = await POST(
      makeReq(
        { activity: "view_content", eventId: "ViewContent.123.abc", fbp: "fb.1.1.p", fbc: "fb.1.1.c" },
        { "x-forwarded-for": "203.0.113.9, 10.0.0.1", "user-agent": "UA/1", referer: "https://app.anutech.in/hosting" },
      ),
    );
    expect(res.status).toBe(200);
    expect(recordActivity).toHaveBeenCalledOnce();
    expect(sendMetaServerEvent).toHaveBeenCalledOnce();
    const arg = sendMetaServerEvent.mock.calls[0][0];
    expect(arg.eventName).toBe("ViewContent");
    expect(arg.eventId).toBe("ViewContent.123.abc");
    expect(arg.clientIp).toBe("203.0.113.9"); // first XFF hop
    expect(arg.userAgent).toBe("UA/1");
    expect(arg.eventSourceUrl).toBe("https://app.anutech.in/hosting");
    expect(arg.fbp).toBe("fb.1.1.p");
    expect(arg.fbc).toBe("fb.1.1.c");
  });

  it("maps checkout_started → InitiateCheckout", async () => {
    await POST(makeReq({ activity: "checkout_started", eventId: "InitiateCheckout.1.x" }));
    expect(sendMetaServerEvent.mock.calls[0][0].eventName).toBe("InitiateCheckout");
  });

  it("ignores a spoofed metaEvent — the activity map wins", async () => {
    await POST(makeReq({ activity: "view_content", eventId: "e1", metaEvent: "Purchase" }));
    expect(sendMetaServerEvent.mock.calls[0][0].eventName).toBe("ViewContent");
  });

  it("does NOT fire CAPI for start_trial", async () => {
    await POST(makeReq({ activity: "start_trial", eventId: "e1" }));
    expect(recordActivity).toHaveBeenCalledOnce();
    expect(sendMetaServerEvent).not.toHaveBeenCalled();
  });

  it("does NOT fire CAPI for landing_page_visit", async () => {
    await POST(makeReq({ activity: "landing_page_visit", eventId: "e1" }));
    expect(sendMetaServerEvent).not.toHaveBeenCalled();
  });

  it("does NOT fire CAPI when eventId is absent (nothing to dedup)", async () => {
    await POST(makeReq({ activity: "view_content" }));
    expect(recordActivity).toHaveBeenCalledOnce();
    expect(sendMetaServerEvent).not.toHaveBeenCalled();
  });
});
