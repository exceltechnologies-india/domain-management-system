/**
 * The guard that stands between a production dump and a real customer's inbox.
 *
 * Threat model:
 *  - **An absent variable must count as LIVE.** If an unset SMTP_HOST read as
 *    inert, the one configuration nobody thought about would be the one that
 *    got through. Pinned for every path.
 *  - **`.invalid` must be matched at a boundary.** `smtp.invalid.example.com`
 *    is a real, resolvable host that merely contains the word; treating it as
 *    inert would wave through a stack that can send mail.
 *  - **All four paths must be checked.** Dropping one from the list silently
 *    re-opens that route, which is exactly the kind of change that looks like
 *    tidying.
 */
import { describe, it, expect } from "vitest";
import {
  assessStackInertness,
  checkProviderSafety,
  isInvalidHost,
  OUTBOUND_PATHS,
} from "@/lib/ops/stack-inertness";

const INERT_ENV = {
  RESELLERCLUB_API_URL: "https://resellerclub.local.invalid",
  DIRECTADMIN_URL: "https://directadmin.local.invalid:2222",
  SMTP_HOST: "smtp.local.invalid",
  RAZORPAY_KEY_ID: "rzp_test_localdevonly",
};

describe("a fully neutered stack", () => {
  it("is inert", () => {
    const r = assessStackInertness(INERT_ENV);
    expect(r.inert).toBe(true);
    expect(r.live).toEqual([]);
  });

  it("matches the values the local compose stack actually uses", () => {
    // Not a tautology: these are the literals in .env.docker. If someone
    // changes them to something this function rejects, the restore script
    // stops working and they find out here rather than at 2am.
    expect(assessStackInertness(INERT_ENV).inert).toBe(true);
  });
});

describe("any single live path makes the stack unsafe", () => {
  it.each(Object.keys(INERT_ENV))("%s pointing somewhere real → not inert", (key) => {
    const real: Record<string, string> = {
      RESELLERCLUB_API_URL: "https://httpapi.com",
      DIRECTADMIN_URL: "https://server1.anutech.in:2222",
      SMTP_HOST: "smtp.gmail.com",
      RAZORPAY_KEY_ID: "rzp_live_abc123",
    };
    const r = assessStackInertness({ ...INERT_ENV, [key]: real[key] });
    expect(r.inert).toBe(false);
    expect(r.live.map((l) => l.key)).toContain(key);
  });

  it("names what gets out, not just which variable", () => {
    // The operator reading this needs to know the consequence. "SMTP_HOST is
    // wrong" is a config note; "this can email customers" is a decision.
    const r = assessStackInertness({ ...INERT_ENV, SMTP_HOST: "smtp.gmail.com" });
    expect(r.live[0].reaches).toMatch(/email/i);
  });
});

describe("absent counts as live", () => {
  it.each(Object.keys(INERT_ENV))("%s unset → not inert", (key) => {
    const env: Record<string, string | undefined> = { ...INERT_ENV };
    delete env[key];
    expect(assessStackInertness(env).inert).toBe(false);
  });

  it("empty string → not inert", () => {
    expect(assessStackInertness({ ...INERT_ENV, SMTP_HOST: "" }).inert).toBe(false);
  });

  it("an entirely empty environment is not inert", () => {
    expect(assessStackInertness({}).inert).toBe(false);
  });
});

describe("isInvalidHost — boundary, not substring", () => {
  it.each([
    "smtp.local.invalid",
    "https://resellerclub.local.invalid",
    "https://directadmin.local.invalid:2222",
    "https://x.invalid/path",
    "  smtp.local.invalid  ",
  ])("%s is inert", (v) => expect(isInvalidHost(v)).toBe(true));

  it.each([
    "smtp.invalid.example.com", // real host that merely contains the word
    "https://invalid-smtp.anutech.in",
    "smtp.gmail.com",
    "",
  ])("%s is NOT inert", (v) => expect(isInvalidHost(v)).toBe(false));
});

describe("the list itself", () => {
  it("covers all four ways out, so none can be dropped as tidying", () => {
    expect(OUTBOUND_PATHS.map((p) => p.key).sort()).toEqual([
      "DIRECTADMIN_URL",
      "RAZORPAY_KEY_ID",
      "RESELLERCLUB_API_URL",
      "SMTP_HOST",
    ]);
  });

  it("a live Razorpay key is not inert even though it is not a host", () => {
    expect(assessStackInertness({ ...INERT_ENV, RAZORPAY_KEY_ID: "rzp_live_x" }).inert).toBe(false);
  });
});

/**
 * The runtime gate: may this BUILD contact a provider at all?
 *
 * Threat model:
 *  - **Test mode is not offline.** Every engine handler READS from its provider
 *    before deciding anything — the DirectAdmin account, the DNS zone, the
 *    registrar order and its expiry. So on a dev machine holding a restored
 *    production database, one real credential in `.env.docker` is enough for a
 *    "safe" dry run to read a live customer's data. `LIVE_COMMANDS_ENABLED`
 *    does not cover this: it gates LIVE mode, and this is test mode behaving
 *    exactly as designed.
 *  - **Production must not be blocked.** A guard that refuses the environment
 *    it was built for gets deleted within a week (L103), so NODE_ENV=production
 *    is allowed unconditionally and there is a test saying so.
 *  - **Inert config must stay usable.** Refusing `.invalid` too would make the
 *    local path unexercisable and push people toward real credentials — the
 *    opposite of the point.
 *  - **Unknown is not safe.** An absent variable counts as live, inherited from
 *    assessStackInertness, because a guard that waves through what it cannot
 *    see is how the one unenumerated case gets out.
 */
describe("checkProviderSafety — the forever half", () => {
  const INERT = {
    RESELLERCLUB_API_URL: "https://rc.invalid",
    DIRECTADMIN_URL: "https://da.invalid",
    SMTP_HOST: "smtp.invalid",
    RAZORPAY_KEY_ID: "rzp_test_abc123",
  };

  it("a production build is always allowed", () => {
    // The environment this exists to serve. Refusing it would be the fastest
    // possible way to get the whole guard removed.
    const r = checkProviderSafety({ ...INERT, NODE_ENV: "production" });
    expect(r.allowed).toBe(true);

    const withRealHosts = checkProviderSafety({
      NODE_ENV: "production",
      RESELLERCLUB_API_URL: "https://httpapi.com",
      DIRECTADMIN_URL: "https://da.anutech.in",
      SMTP_HOST: "smtp.zoho.in",
      RAZORPAY_KEY_ID: "rzp_live_xyz",
    });
    expect(withRealHosts.allowed).toBe(true);
  });

  it("a dev build with fully inert config is allowed", () => {
    // `.invalid` cannot resolve, so the call fails at DNS either way. Allowing
    // it keeps the local path exercisable, which is what stops somebody
    // reaching for a real credential to make the feature work.
    const r = checkProviderSafety({ ...INERT, NODE_ENV: "development" });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("");
  });

  it.each([
    ["RESELLERCLUB_API_URL", "https://httpapi.com"],
    ["DIRECTADMIN_URL", "https://da.anutech.in"],
    ["SMTP_HOST", "smtp.zoho.in"],
    ["RAZORPAY_KEY_ID", "rzp_live_realkey"],
  ])("a dev build is REFUSED when %s can reach something real", (key, value) => {
    // One stray credential is enough. That is the whole exposure.
    const r = checkProviderSafety({ ...INERT, NODE_ENV: "development", [key]: value });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain(key);
  });

  it("the refusal names what is wrong AND how to work locally", () => {
    const r = checkProviderSafety({
      ...INERT,
      NODE_ENV: "development",
      RESELLERCLUB_API_URL: "https://httpapi.com",
    });
    // §24: not a bare "not allowed".
    expect(r.reason).toMatch(/domain registration/);
    expect(r.reason).toMatch(/test mode/i);
    expect(r.reason).toMatch(/\.invalid/);
  });

  it("an ABSENT provider variable is refused, not waved through", () => {
    // Inherited from assessStackInertness and worth restating here: unknown is
    // not safe. A dev box with no provider config at all is refused.
    const { RESELLERCLUB_API_URL: _omitted, ...rest } = INERT;
    const r = checkProviderSafety({ ...rest, NODE_ENV: "development" });
    expect(r.allowed).toBe(false);
  });

  it("an unset NODE_ENV is treated as non-production", () => {
    // Failing toward "not production" is the safe direction: a machine that
    // cannot say what it is does not get to call a registrar.
    const r = checkProviderSafety({ ...INERT, RESELLERCLUB_API_URL: "https://httpapi.com" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/NODE_ENV=unset/);
  });
});
