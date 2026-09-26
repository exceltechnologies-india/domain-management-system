/**
 * GUARD: DMS takes no payment on its own Razorpay keys (round 3, 25 Sep 2026).
 *
 * Owner decision 30 gives every order to ResellerOS. Round 3 closed the last
 * places DMS created a Razorpay order or subscription itself: guest checkout,
 * autopay, the /cart (create-order + verify), the hosting upgrade. This source
 * scan fails if a payment-taking Razorpay call comes back anywhere outside an
 * explicit, reasoned allow-list.
 *
 * What counts as taking a payment: the SDK's `orders.create`,
 * `subscriptions.create`, `payments.capture` or
 * `payments.createRecurringPayment`, a RazorpayService method that wraps one,
 * and importing the Razorpay SDK at all (the import is where a new payment
 * path would start). Reading, verifying, refunding and cancelling are not
 * payments and are not restricted here.
 *
 * ── The allow-list, with the reason for each entry ──────────────────────
 *  lib/razorpay-client.ts            imports the SDK: the one shared client.
 *                                    Makes no payment call itself.
 *  scripts/razorpay-regenerate-plans-live.js
 *                                    imports the SDK to create subscription
 *                                    PLANS (`plans.create`) — a one-off
 *                                    operator script (live key + --apply),
 *                                    not a payment and not reachable from the
 *                                    app. The ONLY place `plans.create` may
 *                                    appear. Its body is still scanned for
 *                                    payment calls.
 *  lib/razorpay.ts — ONLY inside `chargeViaToken`
 *                                    the Razorpay Tokens recurring charger for
 *                                    EXISTING tokens, which the owner asked to
 *                                    leave in place ("disable for now"). Gated
 *                                    OFF by DMS_TOKEN_RECURRING_ENABLED
 *                                    (asserted below). Nothing can create a new
 *                                    token: createCustomer and
 *                                    createRecurringTokenOrder were deleted on
 *                                    26 Sep 2026 (asserted below).
 *  lib/services/payment/recurring-charge-service.ts
 *                                    the only caller of chargeViaToken, behind
 *                                    that gate.
 *
 * Plan creation is refused too (26 Sep 2026, owner: "Stop creating plans"):
 * the admin package edit made a monthly + yearly Razorpay plan on every
 * renewal-price change. That and `RazorpayService.createPlan` were deleted;
 * `plans.create(` may appear only in the operator script above.
 * Red-checked: restoring a `plans.create(` call in lib/razorpay.ts, and a
 * `RazorpayService.createPlan(` call in the admin route, each turned it red.
 *
 * Comments are stripped before scanning (AGENTS.md L46). Re-red-checked on
 * 26 Sep 2026 after the allow-list shrank to chargeViaToken (a restored
 * `createRecurringTokenOrder` calling `orders.create(` turned it red). First
 * red-checked when written: re-adding `RazorpayService.createOrder(` to a route, an
 * `orders.create(` outside the two Tokens methods, and a `from "razorpay"`
 * import in a route each turned this red.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIRS = ["app", "lib", "components", "models", "scripts", "hooks", "store", "middleware"];
const EXT = /\.(ts|tsx|js|mjs|cjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const full = path.join(dir, n);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT.test(n)) out.push(full);
  }
  return out;
}

function strip(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, "/");
const files = [...DIRS.flatMap((d) => walk(path.join(ROOT, d))), path.join(ROOT, "middleware.ts")];
const sources = files.map((f) => ({ file: rel(f), code: strip(readFileSync(f, "utf8")) }));

const SDK_IMPORT = /from\s+["']razorpay["']|require\(\s*["']razorpay["']\s*\)|import\(\s*["']razorpay["']\s*\)/;
const SDK_PAYMENT_CALL = /\b(orders\.create|subscriptions\.create|payments\.capture|payments\.createRecurringPayment)\s*\(/g;
const SDK_IMPORT_ALLOWED = new Set(["lib/razorpay-client.ts", "scripts/razorpay-regenerate-plans-live.js"]);
const TOKENS_METHODS = new Set(["chargeViaToken"]);
const PLAN_CREATE_CALL = /\bplans\.create\s*\(/g;
const PLAN_CREATE_ALLOWED = new Set(["scripts/razorpay-regenerate-plans-live.js"]);

/** The name of the `static async X(` method enclosing `index` in lib/razorpay.ts. */
function enclosingMethod(code: string, index: number): string | null {
  const before = code.slice(0, index);
  const matches = [...before.matchAll(/static\s+(?:async\s+)?(\w+)\s*\(/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

describe("DMS takes no payment on its own Razorpay keys — source scan", () => {
  it("actually scanned the app", () => {
    expect(sources.length).toBeGreaterThan(300);
    expect(sources.some((s) => s.file === "lib/razorpay.ts")).toBe(true);
  });

  it("the Razorpay SDK is imported only by the shared client and the plans script", () => {
    const hits = sources.filter((s) => SDK_IMPORT.test(s.code) && !SDK_IMPORT_ALLOWED.has(s.file)).map((s) => s.file);
    expect(hits).toEqual([]);
  });

  it("no SDK payment call outside the gated chargeViaToken in lib/razorpay.ts", () => {
    const offenders: string[] = [];
    for (const s of sources) {
      for (const m of s.code.matchAll(SDK_PAYMENT_CALL)) {
        if (s.file === "lib/razorpay.ts") {
          const method = enclosingMethod(s.code, m.index ?? 0);
          if (method && TOKENS_METHODS.has(method)) continue;
          offenders.push(`${s.file} (${method ?? "?"}): ${m[1]}`);
        } else {
          offenders.push(`${s.file}: ${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no Razorpay plan is created outside the operator plans script", () => {
    const offenders = sources
      .filter((s) => !PLAN_CREATE_ALLOWED.has(s.file))
      .flatMap((s) => [...s.code.matchAll(PLAN_CREATE_CALL)].map(() => s.file));
    expect(offenders).toEqual([]);
  });

  it("the order, subscription, new-mandate and plan methods stay deleted", () => {
    const DELETED = /\bRazorpayService\.(createOrder|createSubscription|createCustomer|createRecurringTokenOrder|createPlan)\b|static\s+async\s+(createOrder|createSubscription|createCustomer|createRecurringTokenOrder|createPlan)\s*\(/;
    const hits = sources
      .filter((s) => DELETED.test(s.code))
      .map((s) => s.file);
    expect(hits).toEqual([]);
  });

  it("chargeViaToken has no caller except the gated charger", () => {
    const hits = sources
      .filter((s) => s.file !== "lib/razorpay.ts")
      .flatMap((s) =>
        [...s.code.matchAll(/\bRazorpayService\.(chargeViaToken)\b/g)].map(
          (m) => `${s.file}: ${m[1]}`
        )
      )
      .filter((h) => h !== "lib/services/payment/recurring-charge-service.ts: chargeViaToken");
    expect(hits).toEqual([]);
  });

  it("that charger is still gated OFF unless DMS_TOKEN_RECURRING_ENABLED is exactly '1'", () => {
    const svc = sources.find((s) => s.file === "lib/services/payment/recurring-charge-service.ts");
    expect(svc?.code).toMatch(/process\.env\.DMS_TOKEN_RECURRING_ENABLED\s*!==\s*"1"/);
  });

  it("the deleted DMS payment routes stay deleted", () => {
    const gone = [
      "app/api/payments/create-order/route.ts",
      "app/api/payments/verify/route.ts",
      "app/api/payments/guest/create-order/route.ts",
      "app/api/payments/guest/verify/route.ts",
      "app/api/payments/create-subscription/route.ts",
      "app/api/domains/renew/route.ts",
    ];
    expect(sources.filter((s) => gone.includes(s.file)).map((s) => s.file)).toEqual([]);
  });
});
