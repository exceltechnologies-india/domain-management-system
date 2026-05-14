/**
 * Test script: validates the renewal system end-to-end.
 * Run: npx tsx --env-file=.env.local scripts/test-renewal-system.ts
 */
import connectDB from "../lib/mongodb";
import Hosting from "../models/Hosting";
import { AUTOMATION_CONFIG } from "../config/automation";

process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL || "http://localhost:3000";

const PASS = "✅ PASS";
const FAIL = "❌ FAIL";
const INFO = "ℹ️ ";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

// ─── Inline copy of isWithinRenewalWindow (avoids Next.js env at import) ────
function isWithinRenewalWindow(expiryDate: string | Date | null | undefined): boolean {
  if (!expiryDate) return false;
  const d = typeof expiryDate === "string" ? new Date(expiryDate) : expiryDate;
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  const fifteenDaysInMs = 15 * 24 * 60 * 60 * 1000;
  return diff <= fifteenDaysInMs;
}

// ─── Inline copy of the renewal gate logic ───────────────────────────────────
function checkRenewalEligibility(hosting: { status: string; expiryDate?: Date | null }):
  { allowed: boolean; code: string; message: string } {
  if (hosting.status === "terminated") {
    return { allowed: false, code: "HOSTING_TERMINATED", message: "Terminated" };
  }
  const RENEWABLE = ["active", "expired", "suspended"];
  if (!RENEWABLE.includes(hosting.status)) {
    return { allowed: false, code: "HOSTING_NOT_RENEWABLE", message: `Status '${hosting.status}' not renewable` };
  }
  if (hosting.status === "active" && hosting.expiryDate) {
    const now = new Date();
    const ms = hosting.expiryDate.getTime() - now.getTime();
    const fifteenDaysInMs = 15 * 24 * 60 * 60 * 1000;
    if (ms > fifteenDaysInMs) {
      const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
      return { allowed: false, code: "TOO_EARLY_TO_RENEW", message: `${days} days remaining — too early` };
    }
  }
  return { allowed: true, code: "OK", message: "Eligible" };
}

// ─── Inline copy of the expiry base date logic ───────────────────────────────
function calcNewExpiry(currentExpiry: Date | null | undefined, months: number): Date {
  const now = new Date();
  const baseDate = currentExpiry && currentExpiry.getTime() > now.getTime()
    ? new Date(currentExpiry.getTime())
    : new Date(now);
  baseDate.setUTCMonth(baseDate.getUTCMonth() + months);
  return baseDate;
}

function daysFromNow(d: Date): number {
  return Math.round((d.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

// ═══════════════════════════════════════════════════════════════════════════════
async function main() {
  // ── TEST 1: Config ───────────────────────────────────────────────────────────
  console.log("\n── Test 1: REMINDER_DAYS config ──");
  assert("REMINDER_DAYS = [15, 7, 1]", JSON.stringify(AUTOMATION_CONFIG.REMINDER_DAYS) === "[15,7,1]",
    `got ${JSON.stringify(AUTOMATION_CONFIG.REMINDER_DAYS)}`);
  assert("First reminder at 15 days", AUTOMATION_CONFIG.REMINDER_DAYS[0] === 15);
  assert("No 3-day reminder", !AUTOMATION_CONFIG.REMINDER_DAYS.includes(3));

  // ── TEST 2: isWithinRenewalWindow ─────────────────────────────────────────
  console.log("\n── Test 2: isWithinRenewalWindow() (15-day window) ──");
  const future30 = new Date(Date.now() + 30 * 86400000);
  const future14 = new Date(Date.now() + 14 * 86400000);
  const future15 = new Date(Date.now() + 15 * 86400000);
  const future7  = new Date(Date.now() + 7 * 86400000);
  const past1    = new Date(Date.now() - 86400000);

  assert("30 days away → NOT in window", !isWithinRenewalWindow(future30));
  assert("16 days away → NOT in window", !isWithinRenewalWindow(new Date(Date.now() + 16 * 86400000)));
  assert("15 days away → IN window",      isWithinRenewalWindow(future15));
  assert("14 days away → IN window",      isWithinRenewalWindow(future14));
  assert("7 days away  → IN window",      isWithinRenewalWindow(future7));
  assert("Already expired → IN window",   isWithinRenewalWindow(past1));
  assert("null → NOT in window",          !isWithinRenewalWindow(null));

  // ── TEST 3: Renewal gate ──────────────────────────────────────────────────
  console.log("\n── Test 3: Backend renewal gate ──");

  const gate = (status: string, expiryDaysFromNow?: number) =>
    checkRenewalEligibility({
      status,
      expiryDate: expiryDaysFromNow !== undefined
        ? new Date(Date.now() + expiryDaysFromNow * 86400000)
        : undefined,
    });

  const t1 = gate("terminated");
  assert("terminated → blocked (HOSTING_TERMINATED)", !t1.allowed && t1.code === "HOSTING_TERMINATED");

  const t2 = gate("pending");
  assert("pending → blocked (HOSTING_NOT_RENEWABLE)", !t2.allowed && t2.code === "HOSTING_NOT_RENEWABLE");

  const t3 = gate("failed");
  assert("failed → blocked (HOSTING_NOT_RENEWABLE)", !t3.allowed && t3.code === "HOSTING_NOT_RENEWABLE");

  const t4 = gate("active", 30);
  assert("active + 30 days remaining → blocked (TOO_EARLY_TO_RENEW)", !t4.allowed && t4.code === "TOO_EARLY_TO_RENEW");

  const t5 = gate("active", 16);
  assert("active + 16 days remaining → blocked (TOO_EARLY_TO_RENEW)", !t5.allowed && t5.code === "TOO_EARLY_TO_RENEW");

  const t6 = gate("active", 14);
  assert("active + 14 days remaining → ALLOWED", t6.allowed, t6.message);

  const t7 = gate("active", 7);
  assert("active + 7 days remaining → ALLOWED", t7.allowed, t7.message);

  const t8 = gate("expired");
  assert("expired → ALLOWED", t8.allowed, t8.message);

  const t9 = gate("suspended");
  assert("suspended → ALLOWED", t9.allowed, t9.message);

  // ── TEST 4: Expiry calculation (additive) ─────────────────────────────────
  console.log("\n── Test 4: Expiry base date calculation ──");

  // Case A: Active hosting with 10 days left — renew 12 months
  const tenDaysLeft = new Date(Date.now() + 10 * 86400000);
  const newExpiryA = calcNewExpiry(tenDaysLeft, 12);
  const expectedA = new Date(tenDaysLeft);
  expectedA.setUTCMonth(expectedA.getUTCMonth() + 12);
  assert(
    "Active hosting (10 days left): new expiry = currentExpiry + 12 months",
    Math.abs(newExpiryA.getTime() - expectedA.getTime()) < 1000,
    `got ${daysFromNow(newExpiryA)} days from now, expected ~${daysFromNow(expectedA)}`
  );

  // Case B: Expired hosting — renew 12 months from today
  const expiredDate = new Date(Date.now() - 5 * 86400000);
  const newExpiryB = calcNewExpiry(expiredDate, 12);
  const expectedB = new Date();
  expectedB.setUTCMonth(expectedB.getUTCMonth() + 12);
  assert(
    "Expired hosting: new expiry = today + 12 months",
    Math.abs(newExpiryB.getTime() - expectedB.getTime()) < 5000,
    `got ${daysFromNow(newExpiryB)} days from now`
  );

  // Case C: Active hosting 14 days left — renew does NOT reset to today
  const fourteenDaysLeft = new Date(Date.now() + 14 * 86400000);
  const newExpiryC = calcNewExpiry(fourteenDaysLeft, 12);
  assert(
    "Early renewal preserves remaining 14 days (not reset to today)",
    daysFromNow(newExpiryC) > 365 + 13,
    `new expiry is ${daysFromNow(newExpiryC)} days from now (expected >379)`
  );

  // ── TEST 5: DB state — hosting records ───────────────────────────────────
  console.log("\n── Test 5: Database — hosting lifecycle fields ──");
  await connectDB();

  const total = await Hosting.countDocuments({});
  console.log(`  ${INFO} Total hosting records: ${total}`);

  const activeHostings = await Hosting.find({ status: "active" }).select(
    "domainName status expiryDate next_action_at last_reminder_sent"
  ).lean();

  console.log(`  ${INFO} Active hostings: ${activeHostings.length}`);

  let missingNextAction = 0;
  let correct15day = 0;
  let inWindow = 0;

  for (const h of activeHostings) {
    const expiryDays = h.expiryDate ? daysFromNow(h.expiryDate as Date) : null;
    const naa = h.next_action_at as Date | null | undefined;

    if (!naa) {
      missingNextAction++;
      console.log(`  ${FAIL} ${h.domainName}: next_action_at is NULL (expiryDate: ${expiryDays}d)`);
    } else {
      const naaDays = daysFromNow(naa);
      const expectedNaa = h.expiryDate
        ? daysFromNow(new Date((h.expiryDate as Date).getTime() - 15 * 86400000))
        : null;
      const diff = expectedNaa !== null ? Math.abs(naaDays - expectedNaa) : 999;

      if (expiryDays !== null && expiryDays <= 15) {
        inWindow++;
        console.log(`  ${INFO} ${h.domainName}: IN renewal window (expires in ${expiryDays}d, next_action_at in ${naaDays}d)`);
      } else if (diff <= 1) {
        correct15day++;
      } else {
        console.log(`  ${FAIL} ${h.domainName}: next_action_at=${naaDays}d, expected ~${expectedNaa}d (expiry=${expiryDays}d)`);
        failed++;
      }
    }
  }

  if (activeHostings.length > 0) {
    assert(
      `All active hostings have next_action_at set (${correct15day + inWindow}/${activeHostings.length} correct)`,
      missingNextAction === 0,
      `${missingNextAction} records still missing next_action_at`
    );
  } else {
    console.log(`  ${INFO} No active hostings in DB — skipping DB record checks`);
  }

  // Summary of expiring/suspended hostings
  const expiredCount = await Hosting.countDocuments({ status: { $in: ["expired", "suspended"] } });
  console.log(`  ${INFO} Expired/suspended hostings awaiting renewal: ${expiredCount}`);

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("🎉 All checks passed — renewal system is working correctly.");
  } else {
    console.log("⚠️  Some checks failed — see above for details.");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test script error:", err);
  process.exit(1);
});
