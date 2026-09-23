/**
 * A SOURCE SCAN over `scripts/setup-cloud-scheduler-retries.sh`.
 *
 * The script adds Cloud Scheduler retries to three jobs and deliberately leaves
 * three alone. The omissions are the load-bearing part, and an omission reads
 * as an oversight to the next person — "it configures five of eight, let me
 * finish it" is a completely reasonable thought that would put a retry in front
 * of a card-charging endpoint.
 *
 * So the exclusions are asserted, not just commented. AGENTS.md L3: if a second
 * run is not idempotent, the retry is not the change — the idempotency is.
 *
 * This is a scan rather than a behavioural test because the subject is a shell
 * script that talks to Google. What can be checked here is exactly what matters:
 * which job names appear in an update, and which must not.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = "scripts/setup-cloud-scheduler-retries.sh";

const raw = readFileSync(join(process.cwd(), SCRIPT), "utf8");
/**
 * Comments are stripped before asserting absence, because the script documents
 * each excluded job BY NAME and with its reason. A blunt scan would fail on the
 * documentation and the fix would be to delete the reasoning — the exact
 * outcome AGENTS.md L46 warns about.
 */
const code = raw
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#"))
  .join("\n");

/** The JOBS array entries: name|location|attempts|... */
const configured = [...code.matchAll(/^\s*"([a-z-]+)\|/gm)].map((m) => m[1]);

describe("the script scanned is the one we think", () => {
  it("has a JOBS array and an update call", () => {
    // Guard the guard: a rename would make every assertion below vacuous.
    expect(raw).toContain("JOBS=(");
    expect(code).toContain("gcloud scheduler jobs update http");
    expect(configured.length).toBeGreaterThan(0);
  });
});

describe("only the endpoints proven safe get retries", () => {
  it("configures exactly the three that were classified safe", () => {
    expect([...configured].sort()).toEqual([
      "check-unprovisioned",
      "daily-scheduler",
      "pending-sweeper",
    ]);
  });

  it.each([
    [
      "tokens-charge-recurring",
      "charges customer cards; a half-succeeded run has charged some of them",
    ],
    ["tokens-provision-pending", "provisions hosting; idempotency unverified"],
    [
      "check-hosting-expiry",
      "dispatches a Cloud Task per hosting with no lock of its own",
    ],
  ])("%s is NOT configured — %s", (job) => {
    expect(configured).not.toContain(job);
  });

  it("the us-central1 duplicates are left alone", () => {
    // They hit the same endpoints as the europe-west1 pair and should be
    // removed, not configured. Retrying a job nobody knows exists makes it
    // harder to find, not more reliable.
    expect(configured).not.toContain("daily-expiry-check");
    expect(configured).not.toContain("hosting-expiry-check");
  });
});

describe("daily-scheduler's retry must finish inside its row lock", () => {
  /**
   * This is the condition that makes it safe at all. Rows are claimed with
   * `processing_until` for LOCK_DURATION_MS = 10 minutes; a retry inside that
   * window skips claimed rows. A retry that lands AFTER the lock expires would
   * re-process rows the first run already dispatched.
   */
  it("caps total retry duration well under 10 minutes", () => {
    const row = code.match(/"daily-scheduler\|[^"]+"/)?.[0] ?? "";
    const maxDur = row.split("|").pop()?.replace(/["s]/g, "") ?? "";
    const seconds = Number(maxDur);
    expect(Number.isFinite(seconds)).toBe(true);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThan(10 * 60);
  });

  it("the lock it depends on is still 10 minutes", () => {
    // If somebody shortens the lock, the cap above stops being a safe margin
    // and this fails rather than going quietly wrong.
    const route = readFileSync(
      join(process.cwd(), "app/api/cron/daily-scheduler/route.ts"),
      "utf8"
    );
    expect(route).toMatch(/LOCK_DURATION_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/);
  });
});

describe("the script does not quietly do more than it says", () => {
  it("creates no jobs — it only updates ones that already exist", () => {
    expect(code).not.toMatch(/jobs\s+create/);
  });

  it("says the other half of L1 is still open", () => {
    // A retry without an alert is half a fix, and the script should not read as
    // if it closed the issue.
    expect(raw).toMatch(/nothing is told|silent failure/i);
  });
});
