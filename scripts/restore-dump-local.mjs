#!/usr/bin/env node
/**
 * Restore a MongoDB dump into the LOCAL docker-compose Mongo. Nothing else.
 *
 *   node scripts/restore-dump-local.mjs <path-to-dump-dir-or-archive>
 *
 * Written for loading a production export onto a dev machine, which is a
 * reasonable thing to do and a dangerous thing to do carelessly. The danger is
 * not the restore — it is the app that runs against the data afterwards. DMS
 * has crons that email customers, renew domains and provision hosting, and
 * with real rows loaded those crons are pointed at real people.
 *
 * So this script REFUSES unless the local stack is demonstrably inert:
 * ResellerClub, DirectAdmin and SMTP must all resolve to `.invalid` hosts and
 * Razorpay must be a test key. Those are the four ways a row in this database
 * can reach the outside world.
 *
 * That check is configuration, not isolation — the container has working
 * internet (Todos.md §F). Anyone who edits .env.docker with real values while
 * production data is loaded removes the only thing standing between a cron and
 * a customer's inbox. This script cannot prevent that; it can refuse to be the
 * step that set it up.
 *
 * It cannot restore ONTO production, and not because it checks a URI: the
 * restore runs as `docker compose exec mongo mongorestore` INSIDE the local
 * container, so there is no connection string to get wrong. A mistyped
 * argument can only name the wrong dump, never the wrong target.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";

const COMPOSE_SERVICE = "mongo";

/**
 * The target database is read from the RUNNING app's MONGODB_URI, never
 * assumed. A dump carries the SOURCE database's name inside it, and
 * production here is `domain-management` while the local app reads `dms` — so
 * a plain restore lands the data in a database nothing reads, and a script
 * that then counts its own hardcoded guess reports a successful restore of
 * rows the app cannot see. That is what the first version of this file did.
 */

/**
 * The inertness rules live in lib/ops/stack-inertness.ts and are unit-tested
 * there (tests/unit/lib/ops/stack-inertness.test.ts), including that an ABSENT
 * variable counts as live. Loaded rather than restated so the logic that is
 * tested is the logic that runs — a second copy here would be a second thing
 * to go stale, on the one check that stands between a production dump and a
 * real customer's inbox.
 */
const { assessStackInertness, OUTBOUND_PATHS } = await import("tsx/esm/api")
  .then((tsx) => {
    tsx.register();
    return import("../lib/ops/stack-inertness.ts");
  })
  .catch(async () => import("../lib/ops/stack-inertness.ts"));

function fail(msg) {
  console.error(`\n  REFUSED: ${msg}\n`);
  process.exit(1);
}

function composeExec(args, opts = {}) {
  return execFileSync("docker", ["compose", ...args], {
    encoding: "utf8",
    stdio: opts.inherit ? "inherit" : "pipe",
  });
}

// ─── 1. The dump ───────────────────────────────────────────────────────────
const dumpArg = process.argv[2];
if (!dumpArg) {
  console.error(`
  Restore a Mongo dump into the LOCAL stack.

    node scripts/restore-dump-local.mjs <dump-dir|archive.gz>

  To produce the dump from production, on a machine that has the Atlas URI
  (this script never sees it, and must not):

    mongodump --uri="<your-atlas-uri>" --archive=dms-prod.gz --gzip

  Then bring dms-prod.gz here and pass it to this script.
`);
  process.exit(1);
}
const dumpPath = resolve(dumpArg);
if (!existsSync(dumpPath)) fail(`no such dump: ${dumpPath}`);
const isArchive = statSync(dumpPath).isFile();

// ─── 2. The target must be the local container ─────────────────────────────
let running;
try {
  running = composeExec(["ps", "--format", "{{.Service}}"]).split(/\r?\n/).filter(Boolean);
} catch {
  fail("docker compose is not reachable from this directory. Run it from the DMS repo root.");
}
if (!running.includes(COMPOSE_SERVICE)) {
  fail(`the '${COMPOSE_SERVICE}' service is not running. Start the stack first: docker compose up -d`);
}

// ─── 3. The stack must be inert ────────────────────────────────────────────
// Read the values the RUNNING container actually has, not what .env.docker
// says on disk — the container may have been started before an edit.
let env = "";
try {
  env = composeExec(["exec", "-T", "dms", "printenv"]);
} catch {
  fail("could not read the dms container's environment. Is it running?");
}
const envMap = Object.fromEntries(
  env.split(/\r?\n/).filter((l) => l.includes("=")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i), l.slice(i + 1)];
  })
);

const targetUri = envMap.MONGODB_URI ?? "";
const DB_NAME = (targetUri.match(/\/([^/?]+)(\?|$)/) || [])[1];
if (!DB_NAME) {
  fail(`could not read a database name from the container's MONGODB_URI. Got: ${targetUri || "(unset)"}`);
}

const report = assessStackInertness(envMap);
if (!report.inert) {
  console.error(`
  This stack can reach the outside world. Loading production rows into it
  would point real crons at real customers.

  Not inert:`);
  for (const { key, reaches, value } of report.live) {
    console.error(`    ${key.padEnd(22)} = ${value ?? "(unset)"}   -> ${reaches}`);
  }
  console.error(`
  An UNSET variable counts as live on purpose — this cannot tell "email is off"
  from "it falls back to something that works".

  Fix .env.docker so each points at a .invalid host (or an rzp_test_ key),
  then: docker compose up -d --build
`);
  process.exit(1);
}

console.log("  Local stack is inert:");
for (const { key } of OUTBOUND_PATHS) console.log(`    ${key.padEnd(22)} = ${envMap[key]}`);

// ─── 4. Restore ────────────────────────────────────────────────────────────
console.log(`\n  Restoring ${basename(dumpPath)} into the local '${DB_NAME}' database.`);
console.log("  --drop is used, so the LOCAL database is replaced. Production is untouched.\n");

const inContainer = `/tmp/${basename(dumpPath)}`;
try {
  execFileSync("docker", ["compose", "cp", dumpPath, `${COMPOSE_SERVICE}:${inContainer}`], { stdio: "inherit" });
  // --nsFrom/--nsTo remaps the database the dump was taken from onto the one
  // this stack reads. Without it the rows land under the SOURCE name and the
  // app sees an empty database — production here is `domain-management` while
  // the local app reads `dms`.
  //
  // The source name comes from the archive itself ("archive prelude
  // <db>.<collection>", only at -vvv), not from a flag or a guess: a wrong
  // value here silently restores nothing. mongorestore requires the same
  // number of wildcards on both sides, so `*.*` -> `dms.*` is rejected and
  // the concrete name is needed.
  let sourceDb = null;
  try {
    const prelude = composeExec([
      "exec", "-T", COMPOSE_SERVICE, "sh", "-c",
      `mongorestore --archive=${inContainer} ${isArchive ? "--gzip" : ""} --dryRun -vvv 2>&1 | grep -m1 -oE "archive prelude .[^.]+" || true`,
    ]);
    const m = prelude.match(/archive prelude .([A-Za-z0-9_-]+)/);
    if (m) sourceDb = m[1];
  } catch {
    /* fall through to the explicit failure below */
  }
  if (!sourceDb) {
    fail(
      "could not read the source database name out of the archive.\n" +
        "  Without it the rows would restore under the wrong name and the app\n" +
        "  would see an empty database. Check the dump is a valid --archive."
    );
  }
  console.log(`  Dump's database: '${sourceDb}'  ->  restoring as '${DB_NAME}'`);
  const ns = ["--nsFrom", `${sourceDb}.*`, "--nsTo", `${DB_NAME}.*`];
  const restoreArgs = isArchive
    ? ["exec", "-T", COMPOSE_SERVICE, "mongorestore", "--drop", "--gzip", `--archive=${inContainer}`, ...ns]
    : ["exec", "-T", COMPOSE_SERVICE, "mongorestore", "--drop", inContainer, ...ns];
  composeExec(restoreArgs, { inherit: true });
} catch (err) {
  fail(`mongorestore failed: ${err instanceof Error ? err.message : String(err)}`);
}

// ─── 5. Say what landed ────────────────────────────────────────────────────
const counts = composeExec([
  "exec", "-T", COMPOSE_SERVICE, "mongosh", "--quiet", "--eval",
  `const d=db.getSiblingDB("${DB_NAME}");` +
  `d.getCollectionNames().sort().forEach(c=>{const n=d.getCollection(c).countDocuments();if(n)print(c+" "+n)})`,
]);
console.log("\n  Restored:\n" + counts.split(/\r?\n/).filter(Boolean).map((l) => "    " + l).join("\n"));
console.log(`
  This machine now holds real customer data. Two things follow:
    - Do not point .env.docker at a real SMTP host, ResellerClub or
      DirectAdmin while it is loaded. The .invalid values are the only guard.
    - Migration 008 has NOT been run against this dump. If it came from
      production, Domain.orderId is still unique here and multi-domain orders
      will still lose rows:  npm run migrate
`);
