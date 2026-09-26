/**
 * Has a cron stopped running?
 *
 * This is the half of AGENTS.md L1 that retries do not touch. A job that FAILS
 * throws, logs, and now reaches `systemlogs`. A job that stops running — a
 * deleted Scheduler job, a paused one, a service that 404s the path — produces
 * no error at all. It is silent by construction, and the only way to see it is
 * to notice the absence.
 *
 * ─── WHY THIS IS A PURE FUNCTION ─────────────────────────────────────────────
 * Because the last check of this shape I wrote raised a false alarm on its
 * first contact with real data (L39). It reported "the renewals cron has not
 * done its job" about a cron that was working perfectly, because the row it
 * counted had not existed when the step it was measuring against passed. The
 * reasoning was internally consistent and never tested against what the query
 * would actually return.
 *
 * So the decision lives here, with no database, and every branch below is
 * exercised by `staleness.test.ts`.
 *
 * ─── THE THREE CONDITIONS, AND WHY TWO IS NOT ENOUGH ─────────────────────────
 * An alarm requires ALL of:
 *
 *   1. no run inside the window;
 *   2. a run was DUE — enough time has passed that one should have happened;
 *   3. we were WATCHING when it became due.
 *
 * The third is the one everybody leaves out, and it is what stops this crying
 * wolf on the day it ships. On day one no cron has any recorded history, so
 * conditions 1 and 2 hold for every one of them and the first digest would
 * report the entire system as broken — teaching the reader to ignore it before
 * it has ever been right. `watchingSince` is the guard: until the heartbeat
 * itself has been running longer than a cron's interval, "no run recorded" is
 * ignorance, not evidence.
 *
 * A muted alarm is not an alarm (L38).
 */

/** What we expect of a cron, independent of whether it has ever run. */
export interface CronExpectation {
  name: string;
  /**
   * The longest gap that is still normal, in hours. Set it from the SCHEDULE
   * plus slack, not from the schedule alone: a daily job that runs at 03:00
   * legitimately shows a 24h gap the moment before it runs again, so a 24h
   * threshold fires every single day just before the run.
   */
  maxGapHours: number;
}

export type CronVerdict =
  /** Ran successfully inside its window. */
  | { name: string; state: "ok"; lastRunAt: Date }
  /**
   * Overdue AND we were watching long enough for that to mean something.
   * `lastRunAt` is null when it has never been seen at all, which is a
   * different sentence and reads differently in the digest.
   */
  | { name: string; state: "stale"; lastRunAt: Date | null; hoursSince: number; reason: string }
  /**
   * Not enough is known yet. Either the heartbeat has not been watching long
   * enough, or the cron has run recently enough that nothing is due.
   *
   * NOT the same as "ok", deliberately (L38: "nobody knows" and "nothing is
   * wrong" are different answers and only one of them is honest).
   */
  | { name: string; state: "unknown"; reason: string };

export interface CronRunSummary {
  name: string;
  lastRunAt: Date | null;
}

const HOUR_MS = 60 * 60 * 1000;

export function assessCron(input: {
  expectation: CronExpectation;
  lastRunAt: Date | null;
  /** When this heartbeat started recording anything at all. */
  watchingSince: Date | null;
  now: Date;
}): CronVerdict {
  const { expectation, lastRunAt, watchingSince, now } = input;
  const { name, maxGapHours } = expectation;

  if (lastRunAt) {
    const hoursSince = (now.getTime() - lastRunAt.getTime()) / HOUR_MS;
    if (hoursSince <= maxGapHours) {
      return { name, state: "ok", lastRunAt };
    }
    return {
      name,
      state: "stale",
      lastRunAt,
      hoursSince: Math.round(hoursSince),
      reason:
        `last ran ${Math.round(hoursSince)}h ago, which is past its ${maxGapHours}h ` +
        `window. Check the Cloud Scheduler job exists and is ENABLED, and that its last ` +
        `attempt returned 2xx.`,
    };
  }

  /**
   * Never seen. This is where a two-condition check goes wrong: "no successful
   * run" is true of a genuinely dead cron AND of one that was added an hour
   * ago, and only the third condition separates them.
   */
  if (!watchingSince) {
    return {
      name,
      state: "unknown",
      reason:
        "no run has ever been recorded and this heartbeat has no history of its own yet, so " +
        "nothing can be concluded.",
    };
  }

  const watchedHours = (now.getTime() - watchingSince.getTime()) / HOUR_MS;
  if (watchedHours < maxGapHours) {
    return {
      name,
      state: "unknown",
      reason:
        `no run recorded, but this heartbeat has only been watching for ${Math.round(watchedHours)}h ` +
        `of a ${maxGapHours}h window — too early to say whether it is late.`,
    };
  }

  return {
    name,
    state: "stale",
    lastRunAt: null,
    hoursSince: Math.round(watchedHours),
    reason:
      `has NEVER been recorded running, across ${Math.round(watchedHours)}h of watching — longer ` +
      `than its ${maxGapHours}h window. Either no Cloud Scheduler job invokes it, or every ` +
      `attempt is failing before the handler records anything.`,
  };
}

/** Assess every expected cron. Order is the expectation order, for a stable digest. */
export function assessCrons(input: {
  expectations: readonly CronExpectation[];
  runs: readonly CronRunSummary[];
  watchingSince: Date | null;
  now: Date;
}): CronVerdict[] {
  const byName = new Map(input.runs.map((r) => [r.name, r.lastRunAt]));
  return input.expectations.map((expectation) =>
    assessCron({
      expectation,
      lastRunAt: byName.get(expectation.name) ?? null,
      watchingSince: input.watchingSince,
      now: input.now,
    })
  );
}

/**
 * What each cron is expected to do, derived from the Cloud Scheduler jobs that
 * exist — read from GCP on 2026-09-23, not guessed:
 *
 *   daily-scheduler       0 4 * * *   Asia/Kolkata   europe-west1
 *   check-hosting-expiry  0 6 * * *   Asia/Kolkata   europe-west1
 *   check-unprovisioned   5,35 * * *  Asia/Kolkata   europe-west1
 *   pending-sweeper       0 3 * * *   Asia/Kolkata   europe-west1
 *
 * The gaps are the schedule PLUS slack, because a daily job is legitimately
 * 24h-since-last-run in the minute before it runs again. A threshold equal to
 * the period fires every day just before the run, which is the shape that gets
 * an alarm muted.
 *
 * `da-health` is deliberately absent: it has NO Scheduler job at all
 * (confirmed 2026-09-23; `renewal-payment-dunning`, also absent, was deleted
 * on 26 Sep 2026), so listing them here would
 * report a permanent, unfixable "stale" every day — a standing red that trains
 * people to skim past the whole section. That they are unscheduled is recorded
 * in Todos.md, which is where a decision belongs, not in a daily alarm.
 */
export const EXPECTED_CRONS: readonly CronExpectation[] = [
  { name: "daily-scheduler", maxGapHours: 30 },
  { name: "check-hosting-expiry", maxGapHours: 30 },
  { name: "check-unprovisioned", maxGapHours: 3 },
  { name: "pending-sweeper", maxGapHours: 30 },
];
