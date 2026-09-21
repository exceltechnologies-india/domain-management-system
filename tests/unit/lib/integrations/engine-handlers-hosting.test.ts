/**
 * hosting.suspend / hosting.unsuspend — the first commands that touch a provider.
 *
 * Threat model, in the order these actually go wrong:
 *  - **Test mode must not write.** A dry run that suspends somebody's hosting is
 *    worse than no dry run, because the operator ran it BELIEVING it was safe.
 *  - **Already-suspended must be a success.** A retry is the commonest reason to
 *    send the same command twice; failing on it makes a correct state look like
 *    a fault, and leaves the operator unsure which run was the real one.
 *  - **`not_found` must reconcile to `unknown`, never `not_done`.** A missing
 *    account says nothing about whether the suspend landed — the username could
 *    be wrong. `not_done` there frees the subject on no evidence and invites a
 *    requeue (see engine-reconcile's header).
 *  - **A failure before any write must THROW**, so the route records
 *    `transport: "not_sent"` and releases the claim. Returning a failed result
 *    would hold a subject that nothing ever touched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserConfig = vi.fn();
const suspendUser = vi.fn();
const unsuspendUser = vi.fn();

vi.mock("@/lib/integrations/directadmin", () => ({
  getUserConfig: (...a: unknown[]) => getUserConfig(...a),
  suspendUser: (...a: unknown[]) => suspendUser(...a),
  unsuspendUser: (...a: unknown[]) => unsuspendUser(...a),
}));
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  suspendHosting,
  unsuspendHosting,
  reconcileSuspend,
  reconcileUnsuspend,
} from "@/lib/integrations/engine-handlers-hosting";

const found = (suspended: string | undefined) => ({
  kind: "found" as const,
  config: { suspended, username: "acct1" },
});

const ctx = (
  mode: "test" | "live",
  payload: Record<string, unknown> = { username: "acct1" }
) => ({ commandId: "c1", subject: "example.com", mode, payload });

beforeEach(() => {
  getUserConfig.mockReset();
  suspendUser.mockReset();
  unsuspendUser.mockReset();
  suspendUser.mockResolvedValue({ kind: "suspended" });
  unsuspendUser.mockResolvedValue({ kind: "unsuspended" });
});

describe("the request is checked before the provider is touched", () => {
  it("a missing username is refused, and the message says what it is", async () => {
    await expect(suspendHosting(ctx("live", {}))).rejects.toThrow(/"username"/);
    // The distinction that trips people up: the subject is the domain, and
    // DirectAdmin does not key on domains.
    await expect(suspendHosting(ctx("live", {}))).rejects.toThrow(/subject is the domain/i);
    expect(getUserConfig).not.toHaveBeenCalled();
  });

  it("an account DirectAdmin does not have THROWS, so nothing is claimed", async () => {
    getUserConfig.mockResolvedValue({ kind: "user_not_found", reason: "no such user" });
    await expect(suspendHosting(ctx("live"))).rejects.toThrow(/no account called/);
    expect(suspendUser).not.toHaveBeenCalled();
  });

  it("an unreachable DirectAdmin throws with the reason attached", async () => {
    getUserConfig.mockResolvedValue({ kind: "da_unreachable", reason: "ETIMEDOUT" });
    await expect(suspendHosting(ctx("live"))).rejects.toThrow(/ETIMEDOUT/);
    expect(suspendUser).not.toHaveBeenCalled();
  });
});

describe("test mode reads and does not write", () => {
  it("reports what a live run would change, and calls no write", async () => {
    getUserConfig.mockResolvedValue(found("no"));
    const { result } = await suspendHosting(ctx("test"));
    expect(result).toMatchObject({ ok: true, changed: false, dryRun: true });
    expect(result.wouldChange).toBe("active -> suspended");
    expect(suspendUser).not.toHaveBeenCalled();
  });

  it("unsuspend's dry run is the mirror image", async () => {
    getUserConfig.mockResolvedValue(found("yes"));
    const { result } = await unsuspendHosting(ctx("test"));
    expect(result).toMatchObject({ dryRun: true, wouldChange: "suspended -> active" });
    expect(unsuspendUser).not.toHaveBeenCalled();
  });
});

describe("a live run", () => {
  /**
   * This test is the control for every `not.toHaveBeenCalled()` above. Without
   * it, a mock wired up wrongly would make all of them pass while proving
   * nothing — AGENTS.md L14, guard the guard.
   */
  it("suspends an active account and says it changed", async () => {
    getUserConfig.mockResolvedValue(found("no"));
    const { result } = await suspendHosting(ctx("live"));
    expect(suspendUser).toHaveBeenCalledTimes(1);
    expect(suspendUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: "acct1" })
    );
    expect(result).toMatchObject({ ok: true, changed: true, state: "suspended" });
  });

  it("unsuspends a suspended account", async () => {
    getUserConfig.mockResolvedValue(found("yes"));
    const { result } = await unsuspendHosting(ctx("live"));
    expect(unsuspendUser).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ changed: true, state: "active" });
  });

  it("a refusal from DirectAdmin throws rather than reporting success", async () => {
    getUserConfig.mockResolvedValue(found("no"));
    suspendUser.mockResolvedValue({ kind: "hard_failure", reason: "denied" });
    await expect(suspendHosting(ctx("live"))).rejects.toThrow(/refused the suspend/i);
  });
});

describe("already in the asked-for state is a SUCCESS", () => {
  it("suspending a suspended account changes nothing and does not fail", async () => {
    getUserConfig.mockResolvedValue(found("yes"));
    const { result } = await suspendHosting(ctx("live"));
    expect(result).toMatchObject({ ok: true, changed: false, state: "suspended" });
    expect(suspendUser).not.toHaveBeenCalled();
  });

  it("unsuspending an active account changes nothing and does not fail", async () => {
    getUserConfig.mockResolvedValue(found("no"));
    const { result } = await unsuspendHosting(ctx("live"));
    expect(result).toMatchObject({ ok: true, changed: false, state: "active" });
    expect(unsuspendUser).not.toHaveBeenCalled();
  });

  it.each(["yes", "1"])("DirectAdmin's %p both mean suspended", async (flag) => {
    getUserConfig.mockResolvedValue(found(flag));
    const { result } = await suspendHosting(ctx("live"));
    expect(result.changed).toBe(false);
  });
});

describe("the reconcilers read, and refuse to guess", () => {
  const request = { username: "acct1" };
  const rctx = { subject: "example.com", request };

  it("suspended → done for suspend, not_done for unsuspend", async () => {
    getUserConfig.mockResolvedValue(found("yes"));
    expect(await reconcileSuspend(rctx)).toBe("done");
    expect(await reconcileUnsuspend(rctx)).toBe("not_done");
  });

  it("active → done for unsuspend, not_done for suspend", async () => {
    getUserConfig.mockResolvedValue(found("no"));
    expect(await reconcileUnsuspend(rctx)).toBe("done");
    expect(await reconcileSuspend(rctx)).toBe("not_done");
  });

  it("a MISSING account is unknown, not not_done", async () => {
    // The one that matters. not_done here would release the claim and invite a
    // requeue of a command that may well have taken effect.
    getUserConfig.mockResolvedValue({ kind: "user_not_found", reason: "gone" });
    expect(await reconcileSuspend(rctx)).toBe("unknown");
  });

  it("an unreachable provider is unknown", async () => {
    getUserConfig.mockResolvedValue({ kind: "da_unreachable", reason: "ETIMEDOUT" });
    expect(await reconcileSuspend(rctx)).toBe("unknown");
  });

  it("a config with no `suspended` field at all is unknown", async () => {
    // An absent flag is not a "no". Reading it as one would settle a command on
    // a field DirectAdmin never sent.
    getUserConfig.mockResolvedValue(found(undefined));
    expect(await reconcileSuspend(rctx)).toBe("unknown");
  });

  it("a stored request with no username is unknown, and asks the provider nothing", async () => {
    expect(await reconcileSuspend({ subject: "example.com", request: {} })).toBe("unknown");
    expect(getUserConfig).not.toHaveBeenCalled();
  });
});
