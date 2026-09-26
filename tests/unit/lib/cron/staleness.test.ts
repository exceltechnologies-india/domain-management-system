/**
 * Has a cron stopped running?
 *
 * Threat model, and the first one is why this file exists at all:
 *  - **A false alarm on day one is how a check gets muted by day ten** (L39).
 *    On the day this ships no cron has any recorded history, so "no successful
 *    run" and "a run was due" are both true of every one of them. A
 *    two-condition check would report the entire system as broken on its first
 *    digest, and be ignored thereafter. The third condition — were we WATCHING
 *    when it became due — is the whole point.
 *  - **"Unknown" must not collapse into "ok"** (L38). Not enough history is a
 *    different answer from healthy, and only one of them is honest.
 *  - **A threshold equal to the period fires every day just before the run.**
 *    A daily cron is legitimately 24h-since-success in the minute before it
 *    runs again.
 *  - **Never-seen and went-silent need different sentences.** They send the
 *    reader to different places: one to "does a Scheduler job exist at all",
 *    the other to "why did the job that existed stop succeeding".
 */
import { describe, it, expect } from "vitest";
import {
  assessCron,
  assessCrons,
  EXPECTED_CRONS,
  type CronExpectation,
} from "@/lib/cron/staleness";

const NOW = new Date("2026-09-23T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

const daily: CronExpectation = { name: "daily-scheduler", maxGapHours: 30 };

describe("a cron that has run", () => {
  it("inside its window is ok", () => {
    const v = assessCron({
      expectation: daily,
      lastRunAt: hoursAgo(20),
      watchingSince: hoursAgo(500),
      now: NOW,
    });
    expect(v.state).toBe("ok");
  });

  it("is still ok at 24h, because the window has slack", () => {
    // The point of maxGapHours > period: a daily job is legitimately
    // 24h-since-success just before its next run. A 24h threshold would fire
    // every single day and be muted within a fortnight.
    const v = assessCron({
      expectation: daily,
      lastRunAt: hoursAgo(24),
      watchingSince: hoursAgo(500),
      now: NOW,
    });
    expect(v.state).toBe("ok");
  });

  it("past its window is stale, and says what to check", () => {
    const v = assessCron({
      expectation: daily,
      lastRunAt: hoursAgo(50),
      watchingSince: hoursAgo(500),
      now: NOW,
    });
    expect(v.state).toBe("stale");
    if (v.state === "stale") {
      expect(v.hoursSince).toBe(50);
      expect(v.lastRunAt).not.toBeNull();
      // §24 — the reason names the two places to look.
      expect(v.reason).toMatch(/ENABLED/);
      expect(v.reason).toMatch(/2xx/);
    }
  });
});

describe("a cron that has NEVER been recorded — the day-one trap", () => {
  it("is UNKNOWN, not stale, when the heartbeat has no history of its own", () => {
    // The exact shape of L39's false alarm: every condition about the cron is
    // satisfied, and the conclusion is still unsupported.
    const v = assessCron({
      expectation: daily,
      lastRunAt: null,
      watchingSince: null,
      now: NOW,
    });
    expect(v.state).toBe("unknown");
    if (v.state === "unknown") expect(v.reason).toMatch(/nothing can be concluded/);
  });

  it("is UNKNOWN while the heartbeat has watched for less than the window", () => {
    const v = assessCron({
      expectation: daily,
      lastRunAt: null,
      watchingSince: hoursAgo(5),
      now: NOW,
    });
    expect(v.state).toBe("unknown");
    if (v.state === "unknown") expect(v.reason).toMatch(/too early to say/);
  });

  it("becomes STALE once we have watched longer than its window", () => {
    // And only then. This is the transition the whole design turns on.
    const v = assessCron({
      expectation: daily,
      lastRunAt: null,
      watchingSince: hoursAgo(40),
      now: NOW,
    });
    expect(v.state).toBe("stale");
    if (v.state === "stale") {
      expect(v.lastRunAt).toBeNull();
      // A different sentence from "went silent" — it sends the reader to
      // "does a Scheduler job exist", not "why did it start failing".
      expect(v.reason).toMatch(/NEVER been recorded/);
      expect(v.reason).toMatch(/no Cloud Scheduler job invokes it/);
    }
  });

  it("the boundary is the window itself, not a rounded hour", () => {
    const justUnder = assessCron({
      expectation: daily,
      lastRunAt: null,
      watchingSince: hoursAgo(29.9),
      now: NOW,
    });
    const justOver = assessCron({
      expectation: daily,
      lastRunAt: null,
      watchingSince: hoursAgo(30.1),
      now: NOW,
    });
    expect(justUnder.state).toBe("unknown");
    expect(justOver.state).toBe("stale");
  });
});

describe("assessCrons over the real expectation list", () => {
  it("reports one verdict per expectation, in order", () => {
    const out = assessCrons({
      expectations: EXPECTED_CRONS,
      runs: [],
      watchingSince: null,
      now: NOW,
    });
    expect(out).toHaveLength(EXPECTED_CRONS.length);
    expect(out.map((v) => v.name)).toEqual(EXPECTED_CRONS.map((e) => e.name));
  });

  it("on day one, NOTHING is stale", () => {
    // The assertion this file exists for. With no history and no watching
    // window, a two-condition check would mark every cron broken.
    const out = assessCrons({
      expectations: EXPECTED_CRONS,
      runs: [],
      watchingSince: null,
      now: NOW,
    });
    expect(out.filter((v) => v.state === "stale")).toEqual([]);
  });

  it("a cron with no run of its own is judged, not skipped", () => {
    // The dangerous direction: a cron absent from `runs` must not silently
    // pass. Absence is the symptom.
    const out = assessCrons({
      expectations: EXPECTED_CRONS,
      runs: [{ name: "daily-scheduler", lastRunAt: hoursAgo(1) }],
      watchingSince: hoursAgo(400),
      now: NOW,
    });
    expect(out.find((v) => v.name === "daily-scheduler")?.state).toBe("ok");
    expect(out.find((v) => v.name === "pending-sweeper")?.state).toBe("stale");
  });

  it("an unexpected cron in `runs` is ignored rather than reported", () => {
    // A retired cron still writing rows must not appear as a finding. The
    // expectation list is the authority on what SHOULD run.
    const out = assessCrons({
      expectations: EXPECTED_CRONS,
      runs: [{ name: "some-retired-job", lastRunAt: hoursAgo(1) }],
      watchingSince: hoursAgo(400),
      now: NOW,
    });
    expect(out.map((v) => v.name)).not.toContain("some-retired-job");
  });
});

describe("the expectation list matches what is actually scheduled", () => {
  it("every window has slack over its schedule", () => {
    // 24h schedules get 30h; the hourly-ish one gets 3h against a 30-minute
    // cadence. None equals its period, for the reason above.
    for (const e of EXPECTED_CRONS) {
      expect(e.maxGapHours).toBeGreaterThan(0);
    }
    expect(EXPECTED_CRONS.find((e) => e.name === "check-unprovisioned")?.maxGapHours).toBe(3);
  });

  it("the cron with NO Scheduler job is deliberately absent (and the deleted dunning cron stays out)", () => {
    /**
     * `da-health` has no job at all; `renewal-payment-dunning` was deleted on
     * 26 Sep 2026. Neither has a job (confirmed
     * against GCP 2026-09-23). Listing them would produce a permanent daily
     * "stale" that nobody can fix from here — a standing red teaches people to
     * skim the whole section, which costs more than the missing line.
     * That they are unscheduled is a decision recorded in Todos.md.
     */
    const names = EXPECTED_CRONS.map((e) => e.name);
    expect(names).not.toContain("renewal-payment-dunning");
    expect(names).not.toContain("da-health");
  });
});
