/**
 * A SOURCE SCAN, because the risk here is wiring rather than logic.
 *
 * `staleness.ts` decides well and is tested hard. None of that helps if a cron
 * never records a heartbeat: the check would report it stale forever, and the
 * first response to a permanent red is to stop reading the section. The
 * decision being right makes the missing call MORE dangerous, not less.
 *
 * AGENTS.md L75 and L98 are this exact shape three times over — a function
 * wired to one webhook branch of two, a flag honoured by two gates of three, a
 * column written by one send path of three. Each was invisible to a unit test
 * and caught by counting call sites.
 *
 * Two directions are asserted, and both matter:
 *   - every cron this system EXPECTS to run records a heartbeat;
 *   - the heartbeat is recorded AFTER the auth gate, so an unauthorised probe
 *     of the URL cannot make a dead Scheduler job look alive.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EXPECTED_CRONS } from "@/lib/cron/staleness";

const CRON_DIR = "app/api/cron";

function sourceOf(route: string): string {
  return readFileSync(join(process.cwd(), CRON_DIR, route, "route.ts"), "utf8");
}

const routes = readdirSync(join(process.cwd(), CRON_DIR));

describe("the scan found what it expects to scan", () => {
  it("there are cron routes on disk", () => {
    // Guard the guard: a moved directory would make every assertion vacuous.
    expect(routes.length).toBeGreaterThanOrEqual(4);
  });

  it("every EXPECTED_CRONS name is a real route directory", () => {
    // Otherwise the staleness check watches for something that cannot exist,
    // and reports a permanent stale nobody can clear.
    for (const e of EXPECTED_CRONS) {
      expect(routes, `${e.name} is expected but has no route directory`).toContain(e.name);
    }
  });
});

describe("every expected cron records a heartbeat", () => {
  it.each(EXPECTED_CRONS.map((e) => e.name))("%s calls recordCronHeartbeat", (name) => {
    const src = sourceOf(name);
    expect(src).toContain(`recordCronHeartbeat("${name}")`);
  });

  it.each(EXPECTED_CRONS.map((e) => e.name))(
    "%s records it with its OWN name, not a copied one",
    (name) => {
      // A copy-paste that leaves the previous route's name would make one cron
      // vouch for another — the stale one stays silent and the busy one looks
      // twice as healthy.
      const src = sourceOf(name);
      const recorded = [...src.matchAll(/recordCronHeartbeat\("([^"]+)"\)/g)].map((m) => m[1]);
      expect(recorded).toEqual([name]);
    }
  );
});

describe("the heartbeat sits AFTER the auth gate", () => {
  /**
   * The placement is the whole value. Recorded before auth, any probe of the
   * public URL — a scanner, a health check, a curl — would stamp a heartbeat,
   * and a Scheduler job that had been deleted would go on reading as alive.
   * That is worse than no heartbeat, because it looks like evidence.
   */
  it.each(EXPECTED_CRONS.map((e) => e.name))("%s", (name) => {
    const src = sourceOf(name);
    const authAt = src.indexOf("authorizeCronRequest(request)");
    const unauthAt = src.indexOf("Unauthorized");
    const beatAt = src.indexOf("recordCronHeartbeat(");

    expect(authAt, "no auth check found").toBeGreaterThan(-1);
    expect(beatAt, "no heartbeat found").toBeGreaterThan(-1);
    expect(beatAt).toBeGreaterThan(authAt);
    // And after the 401 return, not merely after the call that computes it.
    if (unauthAt > -1) expect(beatAt).toBeGreaterThan(unauthAt);
  });
});

describe("a cron route that is NOT expected is not silently ignored", () => {
  it("names the routes with no Scheduler job, so the gap stays visible", () => {
    /**
     * `da-health` is a real route with no Cloud Scheduler job (confirmed
     * against GCP 2026-09-23). (`renewal-payment-dunning` was here too until it
     * was deleted on 26 Sep 2026.) They are deliberately
     * absent from EXPECTED_CRONS — watching for a cron nothing invokes would
     * produce a permanent daily red, and a standing red gets the whole section
     * skimmed.
     *
     * This test exists so that absence is a recorded decision rather than an
     * oversight. If either gets a job, add it to EXPECTED_CRONS and this list.
     */
    const unwatched = routes.filter(
      (r) => !EXPECTED_CRONS.some((e) => e.name === r)
    );
    expect(unwatched.sort()).toEqual(["da-health"]);
  });
});
