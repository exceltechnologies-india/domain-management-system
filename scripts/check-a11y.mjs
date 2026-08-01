#!/usr/bin/env node
/**
 * Accessibility (jsx-a11y) ratchet gate for the build pipeline.
 *
 * Why this exists: `eslint-plugin-jsx-a11y` is configured (jsx-a11y/recommended
 * in .eslintrc.json) but every rule is set to `warn`, and CI runs
 * `next lint --quiet`, which suppresses warnings entirely — so accessibility
 * was configured but never actually reported or enforced.
 *
 * This script runs the SAME jsx-a11y rules, surfaces every violation, and
 * fails the build only if the count exceeds a frozen baseline. Net effect:
 *   - NEW a11y regressions can't merge (count going up = red build).
 *   - The existing debt (141 at introduction) is visible, not hidden.
 *   - As issues get fixed the count drops; lower A11Y_BASELINE to lock in the
 *     win so it can never regress back up.
 *
 * Usage:  node scripts/check-a11y.mjs      (CI step: npm run lint:a11y)
 * Tune:   A11Y_BASELINE=<n> node scripts/check-a11y.mjs
 */
import { execSync } from "node:child_process";

// Frozen debt baseline. ONLY ever lower this — never raise it to make a red
// build pass. Lowering it after fixes locks in the progress. Started at 141
// (2026-08-01); dropped to 139 after fixing global-error <html lang> +
// CardTitle heading-content.
const BASELINE = Number(process.env.A11Y_BASELINE ?? 139);

function runLintJson() {
  try {
    return execSync("npx next lint --format json", {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"], // stdout only; Next's info lines go to stderr
    });
  } catch (e) {
    // next lint exits non-zero when there are ESLint ERRORS present; the JSON
    // report is still on stdout — use it.
    const out = e.stdout ? e.stdout.toString() : "";
    if (out) return out;
    throw e;
  }
}

let raw = runLintJson();
// `next lint --format json` prints the JSON array, then appends a human-readable
// footer ("...disable some ESLint rules? Learn more..."). Slice to the array's
// bounds — first '[' to last ']'.
const start = raw.indexOf("[");
const end = raw.lastIndexOf("]");
if (start === -1 || end === -1 || end < start) {
  console.error("check-a11y: could not locate JSON array in `next lint` output.");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(raw.slice(start, end + 1));
} catch (e) {
  console.error("check-a11y: invalid JSON from `next lint`:", e.message);
  process.exit(2);
}

const issues = [];
for (const file of report) {
  for (const m of file.messages || []) {
    if (m.ruleId && m.ruleId.startsWith("jsx-a11y/")) {
      issues.push({ file: file.filePath, line: m.line, rule: m.ruleId });
    }
  }
}

const byRule = {};
for (const x of issues) byRule[x.rule] = (byRule[x.rule] || 0) + 1;

console.log(`Accessibility (jsx-a11y) issues: ${issues.length}  |  baseline: ${BASELINE}`);
for (const [rule, count] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${rule}`);
}

if (issues.length > BASELINE) {
  console.error(
    `\n❌ Accessibility regressions: ${issues.length} issues > baseline ${BASELINE}.` +
      `\n   New jsx-a11y violations were introduced. Fix them (or, if intentional,` +
      `\n   add a scoped eslint-disable with justification). New violations:\n`
  );
  for (const x of issues) console.error(`   ${x.file}:${x.line}  ${x.rule}`);
  process.exit(1);
}

if (issues.length < BASELINE) {
  console.log(
    `\n✅ Accessibility improved: ${issues.length} < baseline ${BASELINE}.` +
      `\n   Lower A11Y_BASELINE to ${issues.length} in scripts/check-a11y.mjs to lock it in.`
  );
} else {
  console.log("\n✅ No new accessibility regressions (at baseline).");
}
