// @vitest-environment node
/**
 * checkTrialEligibility — how ResellerOS's answer is classified. The one
 * property everything else rests on: nothing but a clear 200 is ever
 * "eligible".
 */
import { describe, it, expect, vi } from "vitest";
import { checkTrialEligibility } from "@/lib/reselleros/trial-eligibility";

const ENV = { RESELLEROS_SERVER_URL: "https://ros.example.test", DMS_PANEL_API_KEY: "k".repeat(20) };
const Q = { email: "alice@example.com", phone: "9999999999" };
const noSleep = async () => {};

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

describe("checkTrialEligibility", () => {
  it("200 eligible:true → eligible; posts the query with the key, uncached", async () => {
    const fetchImpl = reply(200, { eligible: true });
    expect(await checkTrialEligibility(Q, { fetchImpl, env: ENV })).toEqual({ kind: "eligible" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ros.example.test/api/dms/trial-eligibility");
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${"k".repeat(20)}`);
    expect(JSON.parse(String(init.body))).toEqual(Q);
  });

  it("200 eligible:false → not_eligible with ResellerOS's reason as written", async () => {
    const out = await checkTrialEligibility(Q, {
      fetchImpl: reply(200, { eligible: false, reason: "You had a trial with rao.in." }),
      env: ENV,
    });
    expect(out).toEqual({ kind: "not_eligible", reason: "You had a trial with rao.in." });
  });

  it("200 eligible:false with no reason → still a refusal, with a plain reason", async () => {
    const out = await checkTrialEligibility(Q, { fetchImpl: reply(200, { eligible: false }), env: ENV });
    expect(out.kind).toBe("not_eligible");
  });

  it.each([
    [503, { error: "trial history unreadable" }],
    [400, { error: "email required" }],
    [401, { error: "bad key" }],
    [500, {}],
    [200, { eligible: "yes" }],
    [200, {}],
  ])("HTTP %i %j → cannot_check, never eligible", async (status, body) => {
    const out = await checkTrialEligibility(Q, { fetchImpl: reply(status, body), env: ENV });
    expect(out.kind).toBe("cannot_check");
  });

  it("503 detail carries ResellerOS's error for the log", async () => {
    const out = await checkTrialEligibility(Q, { fetchImpl: reply(503, { error: "history down" }), env: ENV });
    expect(out).toEqual({ kind: "cannot_check", detail: "HTTP 503: history down" });
  });

  it("not configured → cannot_check, nothing sent", async () => {
    const fetchImpl = reply(200, { eligible: true });
    const out = await checkTrialEligibility(Q, { fetchImpl, env: {} });
    expect(out.kind).toBe("cannot_check");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("connection refused → one retry, which can succeed", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce(new Response(JSON.stringify({ eligible: true }), { status: 200 }));
    expect(await checkTrialEligibility(Q, { fetchImpl, env: ENV, sleep: noSleep })).toEqual({ kind: "eligible" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("connection refused twice → cannot_check after exactly two tries", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(refused());
    const out = await checkTrialEligibility(Q, { fetchImpl, env: ENV, sleep: noSleep });
    expect(out.kind).toBe("cannot_check");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("timeout → cannot_check, NOT retried", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const out = await checkTrialEligibility(Q, { fetchImpl, env: ENV, sleep: noSleep });
    expect(out.kind).toBe("cannot_check");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
