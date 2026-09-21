#!/usr/bin/env node
/**
 * Point the sign-in panel's demo buttons at accounts the LOCAL database
 * actually has, after a dump has been restored over the `.invalid` fixtures.
 *
 *   node scripts/demo-logins-local.mjs            # show the picks
 *   node scripts/demo-logins-local.mjs --apply    # set the local passwords
 *
 * Restoring a dump `--drop`s `users`, so the fixtures the panel was built
 * around stop existing and every button fills a credential that cannot sign in
 * — worse than no panel, because it sends whoever tries it hunting for a bug
 * in the auth rather than at a missing row.
 *
 * Stored passwords are bcrypt hashes and are not recoverable, so a working
 * demo login has to be SET rather than discovered. This overwrites the
 * password of the two accounts it picks, in the local database only.
 *
 * Which is why it only ever talks to the compose service: it runs
 * `docker compose exec mongo`, so there is no connection string that could
 * name a remote cluster. Pointed at one, it would lock two people out of
 * their own accounts.
 */
import { execFileSync } from "node:child_process";
import bcrypt from "bcryptjs";

const APPLY = process.argv.includes("--apply");
const SERVICE = "mongo";

/** Development passwords, local database only. */
const PASSWORDS = { admin: "DemoAdmin@2026", customer: "DemoUser@2026" };

const die = (m) => {
  console.error(`\n  ${m}\n`);
  process.exit(1);
};

const mongo = (js) =>
  execFileSync("docker", ["compose", "exec", "-T", SERVICE, "mongosh", "--quiet", "--eval", js], {
    encoding: "utf8",
  });

// The database name comes from the running app, not from a guess — the dump's
// own database (`domain-management`) is not the one the app reads (`dms`).
let dbName;
try {
  const uri = execFileSync("docker", ["compose", "exec", "-T", "dms", "printenv", "MONGODB_URI"], {
    encoding: "utf8",
  }).trim();
  dbName = (uri.match(/\/([^/?]+)(\?|$)/) || [])[1];
} catch {
  die("could not reach the dms container. Is the stack up? docker compose up -d");
}
if (!dbName) die("could not read a database name from the container's MONGODB_URI.");

// Pick an admin, and a non-admin who actually OWNS something — a customer with
// no domain and no hosting signs in to an empty panel, which reads as a broken
// integration rather than an empty account.
const picked = (() => {
  const js = `
    const d = db.getSiblingDB(${JSON.stringify(dbName)});
    const admin = d.users.findOne({ role: "admin", email: { $ne: null } }, { email:1, firstName:1, lastName:1 });
    let customer = null;
    d.users.find({ role: { $ne: "admin" }, email: { $ne: null } }).forEach((u) => {
      if (customer) return;
      const owns = d.domains.countDocuments({ userId: u._id, deletedAt: null })
                 + d.hostings.countDocuments({ userId: u._id });
      if (owns > 0) customer = { email: u.email, firstName: u.firstName, lastName: u.lastName, owns };
    });
    print(JSON.stringify({ admin, customer, users: d.users.countDocuments() }));
  `;
  const raw = mongo(js);
  const line = raw.split(/\r?\n/).find((l) => l.trim().startsWith("{"));
  if (!line) die(`could not parse mongosh output:\n${raw}`);
  return JSON.parse(line);
})();

if (picked.users === 0) {
  die(`local '${dbName}' has no users. Restore a dump first:\n  node scripts/restore-dump-local.mjs <dump>`);
}
if (!picked.admin) die(`no user with role 'admin' in local '${dbName}'.`);
if (!picked.customer) {
  die("no non-admin owns a domain or hosting, so a customer login would land on an empty panel.");
}

const nameOf = (u) => [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email.split("@")[0];
const entries = [
  { label: `Admin · ${nameOf(picked.admin)}`, email: picked.admin.email, password: PASSWORDS.admin },
  {
    label: `Customer · ${nameOf(picked.customer)} (${picked.customer.owns} service${picked.customer.owns === 1 ? "" : "s"})`,
    email: picked.customer.email,
    password: PASSWORDS.customer,
  },
];

console.log(`  Local '${dbName}' — ${picked.users} users\n`);
for (const e of entries) console.log(`    ${e.label}\n      ${e.email}  ·  ${e.password}`);

if (!APPLY) {
  console.log("\n  DRY RUN — no password changed. Re-run with --apply.\n");
  process.exit(0);
}

// Hashed here rather than by the model's pre-save hook, because that hook only
// runs through Mongoose and this writes with mongosh. Same algorithm and cost
// factor as models/User.ts (bcryptjs, 12).
const updates = entries.map((e) => ({ email: e.email, hash: bcrypt.hashSync(e.password, 12) }));
const out = mongo(`
  const d = db.getSiblingDB(${JSON.stringify(dbName)});
  const ups = ${JSON.stringify(updates)};
  let modified = 0, missed = [];
  ups.forEach((u) => {
    const r = d.users.updateOne(
      { email: u.email },
      { $set: { password: u.hash, isActive: true, isActivated: true, updatedAt: new Date() } }
    );
    if (r.matchedCount === 0) missed.push(u.email);
    modified += r.modifiedCount;
  });
  print(JSON.stringify({ modified, missed }));
`);
const result = JSON.parse(out.split(/\r?\n/).find((l) => l.trim().startsWith("{")) || "{}");
if (result.missed?.length) die(`a user vanished between picking and writing: ${result.missed.join(", ")}`);

console.log(`\n  Updated ${result.modified} account(s) in the local database.

  Put these on the panel — docker-compose.yml, under the dms build args:

    NEXT_PUBLIC_DEMO_ACCOUNTS: "${entries.map((e) => `${e.label}|${e.email}|${e.password}`).join(";")}"

  Then: docker compose up -d --build

  A rebuild, not a restart: NEXT_PUBLIC_* is inlined by \`next build\`. The
  deploy script passes neither this nor NEXT_PUBLIC_SHOW_DEMO_ACCOUNTS, so a
  production image carries no panel and none of these values.
`);
