/**
 * lib/reselleros/start-trial.ts — starting the panel trial in ResellerOS.
 * Pinned: the key and body are sent once, never retried; each answer lands in
 * the class of who can fix it; a timeout "may have started", a refused
 * connection did not.
 */
// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { startTrialInResellerOs, startTrialRefusalMessage, type StartTrialBody } from "@/lib/reselleros/start-trial";

const ENV = { RESELLEROS_SERVER_URL: "https://ros.example.test", DMS_PANEL_API_KEY: "k".repeat(20) };
const BODY: StartTrialBody = { dmsUserId: "U1", fullName: "Asha Rao", email: "a@example.test", phone: "9876543210", cycle: "yearly" };
const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("startTrialInResellerOs", () => {
  it("not configured → no request", async () => {
    const f = vi.fn();
    expect((await startTrialInResellerOs(BODY, { env: {}, fetchImpl: f as unknown as typeof fetch })).kind).toBe("not_configured");
    expect(f).not.toHaveBeenCalled();
  });

  it("posts the body with the panel key to /api/dms/start-trial", async () => {
    const f = reply(200, { success: true, leadId: "L-1", trialEnds: "2026-10-11" });
    expect(await startTrialInResellerOs(BODY, { env: ENV, fetchImpl: f })).toEqual({ kind: "ok", leadId: "L-1", trialEnds: "2026-10-11" });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ros.example.test/api/dms/start-trial");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${ENV.DMS_PANEL_API_KEY}`);
    expect(JSON.parse(String(init.body))).toEqual(BODY);
  });

  it("409 alreadyTrialled → already_trialled with ResellerOS's words", async () => {
    const out = await startTrialInResellerOs(BODY, { env: ENV, fetchImpl: reply(409, { error: "You had a trial.", alreadyTrialled: true }) });
    expect(out).toEqual({ kind: "already_trialled", message: "You had a trial." });
  });

  it("400 → refused; 500 with a message → failed", async () => {
    expect(await startTrialInResellerOs(BODY, { env: ENV, fetchImpl: reply(400, { error: "bad" }) })).toEqual({ kind: "refused", message: "bad" });
    expect(await startTrialInResellerOs(BODY, { env: ENV, fetchImpl: reply(500, { error: "db down" }) })).toEqual({ kind: "failed", message: "db down" });
  });

  it.each([401, 503])("%i → config", async (status) => {
    expect((await startTrialInResellerOs(BODY, { env: ENV, fetchImpl: reply(status, { error: "x" }) })).kind).toBe("config");
  });

  it("a timeout → may have started, one attempt", async () => {
    const f = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await startTrialInResellerOs(BODY, { env: ENV, fetchImpl: f as unknown as typeof fetch })).toMatchObject({ kind: "unreachable", mayHaveStarted: true });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a refused connection → did not start", async () => {
    const f = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    expect(await startTrialInResellerOs(BODY, { env: ENV, fetchImpl: f as unknown as typeof fetch })).toMatchObject({ kind: "unreachable", mayHaveStarted: false });
  });
});

describe("startTrialRefusalMessage", () => {
  it("a timeout says check your email before trying again", () => {
    const m = startTrialRefusalMessage({ kind: "unreachable", detail: "t", mayHaveStarted: true }, "help@example.test");
    expect(m).toMatch(/may have gone through/);
    expect(m).toMatch(/check your email/i);
    expect(m).toMatch(/help@example\.test/);
  });
});
