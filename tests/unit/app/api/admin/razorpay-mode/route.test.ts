/**
 * Tests for `app/api/admin/razorpay-mode/route.ts` (slice 7hp, part 1).
 *
 * The single most-secret-sensitive admin endpoint. Manages the test↔live
 * Razorpay key switch + saved-key persistence + a kill-TERM-the-server
 * trigger to re-load .env.local.
 *
 * Threat model:
 *  - **Secret-key leak via GET**: A naive refactor that returns the
 *    Settings map verbatim would dump every Razorpay secret in plain
 *    text. Pinned: GET body carries ONLY booleans
 *    (`hasTestKeys`/`hasLiveKeys`) + public key IDs (`rzp_test_xxx` /
 *    `rzp_live_xxx`) — secrets MUST NOT appear in the body.
 *  - **Action smuggling via discriminated-union bypass**: a save_keys
 *    body trying to switch mode (or vice versa) MUST be rejected by
 *    the discriminated union — not silently routed to the wrong
 *    branch.
 *  - **Switch-mode without target-mode keys**: a refactor that drops
 *    the pre-condition would write empty strings to .env.local and
 *    nuke production Razorpay billing. Pinned with explicit 400.
 *  - **Shell injection via PID file**: the kill-TERM uses execSync
 *    with the raw PID string. parseInt + Number.isFinite + > 0
 *    fences off injection. Pinned by feeding `"99 ; rm -rf /"` as
 *    the PID file content and asserting the route gracefully no-ops.
 *
 * Other pins:
 *  - Admin gate (getAdminFromRequest null → 401)
 *  - GET mode detection from key prefix: `rzp_live_xxx` → live, else test
 *  - save_keys: only fields with `!== undefined` are persisted
 *    (admin can update one field without re-typing the others)
 *  - switch_mode: writes RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
 *    NEXT_PUBLIC_RAZORPAY_KEY_ID; webhook secret only if stored
 *  - restart-failure-graceful: when no PID file is found, response
 *    flips to "re-deploy to apply" instead of "Server is restarting"
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const getSettingsMap = vi.hoisted(() => vi.fn());
const upsertSetting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/settings", () => ({
  getSettingsMap,
  upsertSetting,
}));

vi.mock("@/lib/mongoose", () => ({
  connectToDatabase: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const existsSync = vi.hoisted(() => vi.fn());
const readFileSync = vi.hoisted(() => vi.fn());
const writeFileSync = vi.hoisted(() => vi.fn());
vi.mock("fs", () => ({
  default: { existsSync, readFileSync, writeFileSync },
  existsSync,
  readFileSync,
  writeFileSync,
}));

const execSync = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({
  default: { execSync },
  execSync,
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, POST } from "@/app/api/admin/razorpay-mode/route";

const SECRET_SENTINELS = {
  testSecret: "rzp_test_secret_LEAK_ME_PLEASE",
  liveSecret: "rzp_live_secret_LEAK_ME_PLEASE",
  webhookSecret: "whk_secret_LEAK_ME_PLEASE",
};

function makeReq(method: "GET" | "POST", body?: unknown) {
  return new NextRequest("https://example.com/api/admin/razorpay-mode", {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue({ _id: "ADMIN1" });
  getSettingsMap.mockReset();
  upsertSetting.mockReset().mockResolvedValue(undefined);
  existsSync.mockReset().mockReturnValue(false);
  readFileSync.mockReset().mockReturnValue("");
  writeFileSync.mockReset();
  execSync.mockReset();
});

// ─────────────────────────── GET ─────────────────────────────

describe("GET — admin gate", () => {
  it("non-admin → 401", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(401);
    expect(getSettingsMap).not.toHaveBeenCalled();
  });
});

describe("GET — mode detection from RAZORPAY_KEY_ID prefix", () => {
  it("env file has RAZORPAY_KEY_ID=rzp_live_xxx → mode='live'", async () => {
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce("RAZORPAY_KEY_ID=rzp_live_ABC123");
    getSettingsMap.mockResolvedValueOnce({});
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.mode).toBe("live");
    expect(body.currentKeyId).toBe("rzp_live_ABC123");
  });

  it("env file has RAZORPAY_KEY_ID=rzp_test_xxx → mode='test'", async () => {
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce("RAZORPAY_KEY_ID=rzp_test_ABC123");
    getSettingsMap.mockResolvedValueOnce({});
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.mode).toBe("test");
  });

  it("empty env (no key set) → mode='test' (default-safe)", async () => {
    existsSync.mockReturnValueOnce(false);
    delete process.env.RAZORPAY_KEY_ID;
    getSettingsMap.mockResolvedValueOnce({});
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.mode).toBe("test");
    expect(body.currentKeyId).toBe("");
  });
});

describe("GET — NO-SECRET-LEAK response shape", () => {
  it("response carries hasTestKeys / hasLiveKeys booleans + public key IDs ONLY (NEVER secrets)", async () => {
    existsSync.mockReturnValueOnce(true);
    readFileSync.mockReturnValueOnce("RAZORPAY_KEY_ID=rzp_test_PUB");
    getSettingsMap.mockResolvedValueOnce({
      razorpay_test_key_id: "rzp_test_PUB",
      razorpay_test_key_secret: SECRET_SENTINELS.testSecret,
      razorpay_live_key_id: "rzp_live_PUB",
      razorpay_live_key_secret: SECRET_SENTINELS.liveSecret,
    });
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.hasTestKeys).toBe(true);
    expect(body.hasLiveKeys).toBe(true);
    expect(body.testKeyId).toBe("rzp_test_PUB");
    expect(body.liveKeyId).toBe("rzp_live_PUB");
    // Negative leak guard — secrets MUST NOT appear in the body
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(SECRET_SENTINELS.testSecret);
    expect(raw).not.toContain(SECRET_SENTINELS.liveSecret);
  });

  it("test secret saved but ID absent → hasTestKeys=false (strict AND)", async () => {
    existsSync.mockReturnValueOnce(false);
    getSettingsMap.mockResolvedValueOnce({
      razorpay_test_key_secret: SECRET_SENTINELS.testSecret,
    });
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.hasTestKeys).toBe(false);
    expect(body.testKeyId).toBe("");
  });

  it("test ID saved but secret absent → hasTestKeys=false (strict AND)", async () => {
    existsSync.mockReturnValueOnce(false);
    getSettingsMap.mockResolvedValueOnce({
      razorpay_test_key_id: "rzp_test_xxx",
    });
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.hasTestKeys).toBe(false);
  });
});

// ─────────────────────────── POST ─────────────────────────────

describe("POST — admin gate + zod discriminated union", () => {
  it("non-admin → 401", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq("POST", { action: "save_keys", testKeyId: "x" })
    );
    expect(res.status).toBe(401);
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  it("unknown action → 400 (zod discriminated union rejects)", async () => {
    const res = await POST(makeReq("POST", { action: "delete_everything" }));
    expect(res.status).toBe(400);
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  it("ACTION SMUGGLE: switch_mode + extra liveKeyId field → zod accepts liveKeyId as unknown but switch branch ignores it (no key written to settings)", async () => {
    getSettingsMap.mockResolvedValueOnce({
      razorpay_test_key_id: "rzp_test_ABC",
      razorpay_test_key_secret: "secret",
    });
    existsSync.mockReturnValue(false);
    await POST(
      makeReq("POST", {
        action: "switch_mode",
        mode: "test",
        liveKeyId: "rzp_live_SMUGGLED",
      })
    );
    // No setting was upserted with the smuggled field
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  it("switch_mode with invalid mode value → 400", async () => {
    const res = await POST(
      makeReq("POST", { action: "switch_mode", mode: "preview" })
    );
    expect(res.status).toBe(400);
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});

describe("POST save_keys — partial-update semantics", () => {
  it("ONLY supplied fields are persisted (admin can update webhook secret without re-typing keys)", async () => {
    await POST(
      makeReq("POST", {
        action: "save_keys",
        webhookSecret: "whk_NEW",
      })
    );
    expect(upsertSetting).toHaveBeenCalledTimes(1);
    expect(upsertSetting).toHaveBeenCalledWith(
      "razorpay_webhook_secret",
      "whk_NEW",
      expect.objectContaining({ category: "payment", updatedBy: "ADMIN1" })
    );
  });

  it("all 5 fields supplied → all 5 upserts fire in parallel (Promise.all)", async () => {
    await POST(
      makeReq("POST", {
        action: "save_keys",
        testKeyId: "rzp_test_NEW",
        testKeySecret: "test_NEW",
        liveKeyId: "rzp_live_NEW",
        liveKeySecret: "live_NEW",
        webhookSecret: "whk_NEW",
      })
    );
    expect(upsertSetting).toHaveBeenCalledTimes(5);
    const keys = upsertSetting.mock.calls.map((c) => c[0]).sort();
    expect(keys).toEqual([
      "razorpay_live_key_id",
      "razorpay_live_key_secret",
      "razorpay_test_key_id",
      "razorpay_test_key_secret",
      "razorpay_webhook_secret",
    ]);
  });

  it("response: 200 success message", async () => {
    const res = await POST(makeReq("POST", { action: "save_keys" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe("Keys saved successfully");
  });
});

describe("POST switch_mode — pre-condition (target keys must exist)", () => {
  it("switch to 'live' without saved live keys → 400 'Please save live keys first'; NO env write", async () => {
    getSettingsMap.mockResolvedValueOnce({
      // empty — no live keys
    });
    const res = await POST(
      makeReq("POST", { action: "switch_mode", mode: "live" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("live");
    expect(body.error).toContain("save");
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
  });

  it("switch to 'test' without saved test keys → 400", async () => {
    getSettingsMap.mockResolvedValueOnce({});
    const res = await POST(
      makeReq("POST", { action: "switch_mode", mode: "test" })
    );
    expect(res.status).toBe(400);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("switch to 'live' WITH saved live keys → writes .env.local with RAZORPAY_KEY_ID + KEY_SECRET + NEXT_PUBLIC_RAZORPAY_KEY_ID", async () => {
    getSettingsMap.mockResolvedValueOnce({
      razorpay_live_key_id: "rzp_live_K",
      razorpay_live_key_secret: SECRET_SENTINELS.liveSecret,
      razorpay_webhook_secret: SECRET_SENTINELS.webhookSecret,
    });
    existsSync.mockReturnValue(false); // no existing .env
    // PID file absent so the kill branch fails gracefully
    await POST(makeReq("POST", { action: "switch_mode", mode: "live" }));
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const written = writeFileSync.mock.calls[0][1] as string;
    expect(written).toContain("RAZORPAY_KEY_ID=rzp_live_K");
    expect(written).toContain(`RAZORPAY_KEY_SECRET=${SECRET_SENTINELS.liveSecret}`);
    expect(written).toContain("NEXT_PUBLIC_RAZORPAY_KEY_ID=rzp_live_K");
    expect(written).toContain(`RAZORPAY_WEBHOOK_SECRET=${SECRET_SENTINELS.webhookSecret}`);
  });

  it("no webhook secret stored → only 3 env keys written (no RAZORPAY_WEBHOOK_SECRET line)", async () => {
    getSettingsMap.mockResolvedValueOnce({
      razorpay_live_key_id: "rzp_live_K",
      razorpay_live_key_secret: "secret",
      // no razorpay_webhook_secret
    });
    existsSync.mockReturnValue(false);
    await POST(makeReq("POST", { action: "switch_mode", mode: "live" }));
    const written = writeFileSync.mock.calls[0][1] as string;
    expect(written).not.toContain("RAZORPAY_WEBHOOK_SECRET");
  });
});

describe("POST switch_mode — SIGTERM shell-injection guard", () => {
  function setupValidSwitch() {
    getSettingsMap.mockResolvedValueOnce({
      razorpay_test_key_id: "rzp_test_K",
      razorpay_test_key_secret: "s",
    });
    existsSync.mockImplementation((p: string) => {
      // PID file present; env file absent (so it's created)
      return p.includes(".server.pid");
    });
  }

  it("valid integer PID → execSync kill-TERM called", async () => {
    setupValidSwitch();
    readFileSync.mockReturnValueOnce("12345");
    await POST(makeReq("POST", { action: "switch_mode", mode: "test" }));
    expect(execSync).toHaveBeenCalledTimes(1);
    expect(execSync.mock.calls[0][0]).toBe("kill -TERM 12345 2>/dev/null || true");
  });

  it("INJECTION: PID file contains '99 ; rm -rf /' → parseInt yields 99 → execSync called with sanitised int (NOT the raw string)", async () => {
    setupValidSwitch();
    readFileSync.mockReturnValueOnce("99 ; rm -rf /");
    await POST(makeReq("POST", { action: "switch_mode", mode: "test" }));
    // execSync MUST receive the sanitised integer, never the injected string
    expect(execSync).toHaveBeenCalledTimes(1);
    expect(execSync.mock.calls[0][0]).toBe("kill -TERM 99 2>/dev/null || true");
    expect(execSync.mock.calls[0][0]).not.toContain("rm -rf");
  });

  it("PID = 0 → guarded off; execSync NOT called; response degrades to 're-deploy to apply'", async () => {
    setupValidSwitch();
    readFileSync.mockReturnValueOnce("0");
    const res = await POST(
      makeReq("POST", { action: "switch_mode", mode: "test" })
    );
    expect(execSync).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.restartTriggered).toBe(false);
    expect(body.message).toContain("re-deploy to apply");
  });

  it("PID = negative → guarded off", async () => {
    setupValidSwitch();
    readFileSync.mockReturnValueOnce("-1");
    await POST(makeReq("POST", { action: "switch_mode", mode: "test" }));
    expect(execSync).not.toHaveBeenCalled();
  });

  it("PID file missing → graceful degrade, NOT a 500", async () => {
    getSettingsMap.mockResolvedValueOnce({
      razorpay_test_key_id: "rzp_test_K",
      razorpay_test_key_secret: "s",
    });
    existsSync.mockReturnValue(false); // no env, no PID file
    readFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const res = await POST(
      makeReq("POST", { action: "switch_mode", mode: "test" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.restartTriggered).toBe(false);
    expect(body.message).toContain("re-deploy to apply");
  });
});

describe("POST switch_mode — response message branch", () => {
  it("restart triggered → 'Server is restarting' message", async () => {
    getSettingsMap.mockResolvedValueOnce({
      razorpay_test_key_id: "rzp_test_K",
      razorpay_test_key_secret: "s",
    });
    existsSync.mockImplementation((p: string) =>
      p.includes(".server.pid")
    );
    readFileSync.mockReturnValueOnce("12345");
    const res = await POST(
      makeReq("POST", { action: "switch_mode", mode: "test" })
    );
    const body = await res.json();
    expect(body.restartTriggered).toBe(true);
    expect(body.message).toContain("restarting");
    expect(body.mode).toBe("test");
  });
});
