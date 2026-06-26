/**
 * Tests for `lib/services/payment/tokens-da-provisioner.ts` (Phase 2E).
 *
 * The Tokens-flow DA-provisioning cron service. Coverage:
 *  - findPendingTokensFlowHostings: query shape (status='pending' +
 *    razorpayTokenId present + directAdminUsername empty/absent)
 *  - provisionTokensFlowHosting:
 *    - Happy path: creates DA user → sets Hosting.directAdminUsername
 *      + flips status='active'; mirrors onto User; sends welcome email
 *    - Idempotency: Hosting already has directAdminUsername → 'skipped'
 *    - User not found → 'hard_failure' (no DA call)
 *    - DA returns 'da_unreachable' → 'da_unreachable'; status STILL
 *      'pending' (cron retries next run)
 *    - DA returns 'username_collision_exhausted' → 'collision_exhausted'
 *    - DA returns 'hard_failure' → 'hard_failure'
 *    - Welcome email failure does NOT block the status flip (mandate
 *      is set up + DA user exists; email is best-effort)
 *
 * All DB models + DA helper + email service mocked at module boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findHostingDocs = vi.hoisted(() => vi.fn());
const HostingFind = vi.hoisted(() => {
  const chain = {
    sort: () => chain,
    limit: () => chain,
    exec: () => findHostingDocs(),
  };
  return vi.fn(() => chain);
});
vi.mock("@/models/Hosting", () => ({
  default: { find: HostingFind },
  __esModule: true,
}));

const daCreateUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/directadmin", () => ({ createUser: daCreateUser }));

vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: { NAMESERVERS: ["ns1.example.com", "ns2.example.com"] },
  DA_SERVER_IP: "35.208.86.44",
}));

const sendHostingProvisionedEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendHostingProvisionedEmail },
}));

const getUserById = vi.hoisted(() => vi.fn());
const setUserDirectAdminUsername = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({
  getUserById,
  setUserDirectAdminUsername,
}));

const getPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ getPlanByPlanId }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  findPendingTokensFlowHostings,
  provisionTokensFlowHosting,
} from "@/lib/services/payment/tokens-da-provisioner";

function makeHosting(over: Record<string, unknown> = {}) {
  return {
    _id: "host_PENDING",
    userId: "U1",
    domainName: "trial.example.com",
    planId: "starter",
    serverPackage: "Starter",
    status: "pending",
    directAdminUsername: "",
    razorpayCustomerId: "cust_X",
    razorpayTokenId: "token_X",
    expiryDate: new Date(),
    save: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

beforeEach(() => {
  HostingFind.mockClear();
  findHostingDocs.mockReset().mockResolvedValue([]);
  daCreateUser.mockReset();
  sendHostingProvisionedEmail.mockReset().mockResolvedValue(undefined);
  getUserById.mockReset().mockResolvedValue({
    _id: "U1",
    email: "user@x.com",
    firstName: "Test",
    directAdminUsername: undefined,
  });
  setUserDirectAdminUsername.mockReset().mockResolvedValue(undefined);
  getPlanByPlanId.mockReset().mockResolvedValue({ planId: "starter", name: "Starter" });
});

describe("findPendingTokensFlowHostings", () => {
  it("queries with status=pending + razorpayTokenId present + directAdminUsername empty/absent", async () => {
    await findPendingTokensFlowHostings();
    const filter = (HostingFind.mock.calls as unknown as [[{
      status?: string;
      razorpayTokenId?: { $exists?: boolean };
      $or?: Array<{ directAdminUsername?: string | { $exists?: boolean } }>;
    }]])[0][0];
    expect(filter.status).toBe("pending");
    expect(filter.razorpayTokenId).toMatchObject({ $exists: true });
    expect(filter.$or).toEqual(
      expect.arrayContaining([
        { directAdminUsername: "" },
        { directAdminUsername: { $exists: false } },
      ])
    );
  });
});

describe("provisionTokensFlowHosting — happy path", () => {
  it("creates DA user → sets directAdminUsername + flips status='active'; mirrors onto User; sends welcome email", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "trialx12345" });
    const hosting = makeHosting();

    const result = await provisionTokensFlowHosting(
      hosting as unknown as Parameters<typeof provisionTokensFlowHosting>[0]
    );

    expect(result.outcome).toBe("activated");
    expect(result.daUsername).toBe("trialx12345");

    expect(daCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "user@x.com",
        domain: "trial.example.com",
        packageName: "Starter",
        ip: "35.208.86.44",
      })
    );
    // 3 username candidates generated
    expect(daCreateUser.mock.calls[0][0].usernameCandidates).toHaveLength(3);

    // Hosting was updated + saved
    const h = hosting as unknown as { directAdminUsername: string; status: string };
    expect(h.directAdminUsername).toBe("trialx12345");
    expect(h.status).toBe("active");
    expect(hosting.save).toHaveBeenCalled();

    // User got the username mirrored (User.directAdminUsername was unset)
    expect(setUserDirectAdminUsername).toHaveBeenCalledWith("U1", "trialx12345");

    // Welcome email sent
    expect(sendHostingProvisionedEmail).toHaveBeenCalledWith(
      "user@x.com",
      "Test",
      expect.objectContaining({
        domainName: "trial.example.com",
        packageName: "Starter",
        planName: "Starter",
      })
    );
  });

  it("does NOT overwrite User.directAdminUsername if already set", async () => {
    getUserById.mockResolvedValueOnce({
      _id: "U1",
      email: "user@x.com",
      firstName: "Test",
      directAdminUsername: "alreadyhad",
    });
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "newone" });
    await provisionTokensFlowHosting(
      makeHosting() as unknown as Parameters<typeof provisionTokensFlowHosting>[0]
    );
    expect(setUserDirectAdminUsername).not.toHaveBeenCalled();
  });
});

describe("provisionTokensFlowHosting — early-exit + failure cases", () => {
  it("idempotency: directAdminUsername already set → 'skipped' without calling DA", async () => {
    const hosting = makeHosting({ directAdminUsername: "exists" });
    const result = await provisionTokensFlowHosting(
      hosting as unknown as Parameters<typeof provisionTokensFlowHosting>[0]
    );
    expect(result.outcome).toBe("skipped");
    expect(daCreateUser).not.toHaveBeenCalled();
  });

  it("user not found → 'hard_failure' (no DA call)", async () => {
    getUserById.mockResolvedValueOnce(null);
    const result = await provisionTokensFlowHosting(
      makeHosting() as unknown as Parameters<typeof provisionTokensFlowHosting>[0]
    );
    expect(result.outcome).toBe("hard_failure");
    expect(result.reason).toMatch(/user U1 not found/);
    expect(daCreateUser).not.toHaveBeenCalled();
  });

  it("DA unreachable → 'da_unreachable'; status STILL 'pending' so cron retries", async () => {
    daCreateUser.mockResolvedValueOnce({
      kind: "da_unreachable",
      reason: "ECONNREFUSED",
    });
    const hosting = makeHosting();
    const result = await provisionTokensFlowHosting(
      hosting as unknown as Parameters<typeof provisionTokensFlowHosting>[0]
    );
    expect(result.outcome).toBe("da_unreachable");
    expect(result.reason).toBe("ECONNREFUSED");
    expect((hosting as unknown as { status: string }).status).toBe("pending");
    expect(hosting.save).not.toHaveBeenCalled();
  });

  it("DA returns 'username_collision_exhausted' → 'collision_exhausted'", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "username_collision_exhausted" });
    const result = await provisionTokensFlowHosting(
      makeHosting() as unknown as Parameters<typeof provisionTokensFlowHosting>[0]
    );
    expect(result.outcome).toBe("collision_exhausted");
  });

  it("DA returns 'hard_failure' → 'hard_failure'", async () => {
    daCreateUser.mockResolvedValueOnce({
      kind: "hard_failure",
      reason: "License limited",
    });
    const result = await provisionTokensFlowHosting(
      makeHosting() as unknown as Parameters<typeof provisionTokensFlowHosting>[0]
    );
    expect(result.outcome).toBe("hard_failure");
    expect(result.reason).toBe("License limited");
  });

  it("welcome email failure does NOT block status flip / DA user creation", async () => {
    daCreateUser.mockResolvedValueOnce({ kind: "created", username: "userxxx" });
    sendHostingProvisionedEmail.mockRejectedValueOnce(new Error("SMTP timeout"));
    const hosting = makeHosting();
    const result = await provisionTokensFlowHosting(
      hosting as unknown as Parameters<typeof provisionTokensFlowHosting>[0]
    );
    expect(result.outcome).toBe("activated");
    expect((hosting as unknown as { status: string }).status).toBe("active");
    expect(hosting.save).toHaveBeenCalled();  // Save happened BEFORE email
  });
});
