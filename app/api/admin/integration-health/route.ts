/**
 * Integration Health — aggregated upstream-provider error feed for the
 * admin panel.
 *
 * Collects errors from two places:
 *
 *   1. `Order.domains[i].error` for any `domain` sub-doc with
 *      `status === 'failed'`. Since dms-00194-mlz the hosting provisioner
 *      writes the raw upstream reply (DA `Cannot Execute Your Request -
 *      License is limited to 2 accounts`, ResellerClub error codes, etc.)
 *      into this field. The customer order page suppresses it (see
 *      dms-00195-wsk); this endpoint is where the operator actually sees it.
 *
 *   2. `Order.zohoInvoiceId === 'creation_failed'` — orders whose Zoho
 *      Books invoice never resolved. The existing Invoice Diagnostics
 *      panel already surfaces these, but we mirror them here so a single
 *      page covers ALL upstream-provider failures (DA + RC + Zoho + Razorpay)
 *      in one view.
 *
 * Each error is classified into a provider by keyword match, then grouped
 * with similar errors (normalised first 80 chars) so a recurring pattern
 * — e.g. license-cap rejection across 4 orders — shows as one row with a
 * count, not 4 separate rows. Each pattern carries an `actionableHint`
 * mapped from the matched signature: license cap → "Upgrade DA license or
 * delete unused accounts"; tax-code rejection → "Verify ZOHO_TAX_ID_*";
 * etc. Adding a new hint is one entry in the map below.
 */

import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { serverLogger } from "@/lib/server-logger";
import Order from "@/models/Order";
import SystemLog from "@/models/SystemLog";
import connectDB from "@/lib/mongodb";

export const dynamic = "force-dynamic";

type ProviderId =
  | "directadmin"
  | "resellerclub"
  | "zoho"
  | "razorpay"
  | "email"
  | "auth"
  | "background"
  | "application"
  | "unknown";

/**
 * SystemLog `service` field → provider mapping. Each serverLogger.error()
 * call site sets `service` on the meta object (e.g. `{ service: "razorpay" }`)
 * and that flows through to SystemLog.service via lib/server-logger.ts.
 * Falls back to keyword-match classification when service is unset.
 */
const SERVICE_TO_PROVIDER: Record<string, ProviderId> = {
  directadmin: "directadmin",
  da: "directadmin",
  resellerclub: "resellerclub",
  rc: "resellerclub",
  zoho: "zoho",
  zohobooks: "zoho",
  razorpay: "razorpay",
  payment: "razorpay",
  email: "email",
  smtp: "email",
  mailer: "email",
  auth: "auth",
  nextauth: "auth",
  login: "auth",
  cron: "background",
  worker: "background",
  scheduler: "background",
  api: "application",
  middleware: "application",
};

interface ProviderClassifier {
  id: ProviderId;
  label: string;
  // The patterns are checked in order. First match wins.
  signatures: { needle: RegExp; hint?: string }[];
}

const PROVIDERS: ProviderClassifier[] = [
  {
    id: "directadmin",
    label: "DirectAdmin",
    signatures: [
      {
        needle: /license is limited|cannot execute your request.*license/i,
        hint: "DirectAdmin license tier is at its account quota. Either delete an unused user in DA admin (Account Manager → Show All Users) or upgrade the license to a higher tier from the DA license provider.",
      },
      {
        needle: /that ip does not exist in your list|ip does not exist/i,
        hint: "The `DIRECTADMIN_IP` env var our code sends to DA's create-user API isn't in the DA server's IP Manager list. Open the new DA admin → Server Manager → IP Manager → copy the active IP, then set `DIRECTADMIN_IP=<ip>` in `.env.local` AND verify it's in `deploy-cloud-run.sh`'s ENV_VARS list. Redeploy. Bit us 2026-06-22 right after the DA server switch — the literal fallback in `lib/directadmin/client.ts` was the OLD server's IP.",
      },
      {
        needle: /cannot create account.*package not found|package not found/i,
        hint: "DA rejected the create-user call because the package name our code is sending (Starter / Standard / Plus by default) doesn't exist on the DA server. Open DA admin → Server Manager → Manage User Packages → create the three commercial packages with the right disk / bandwidth / inode limits per tier.",
      },
      {
        needle: /cannot create account.*invalid domain name|invalid domain name/i,
        hint: "DA rejected the create-user call because it considers the domain name invalid. Two common causes: (1) the TLD isn't in DA's whitelist — check `/usr/local/directadmin/data/templates/valid_TLDs` or DA admin → Server Manager → DNS Administration → TLD list, and add any newer / country-code TLD (e.g. `.ai`, `.tech`) the platform sells but DA doesn't yet know about. (2) DA is doing a live-DNS check and the domain isn't registered yet on the registrar side (race between RC completing the registration + our code calling DA). If (1), update DA. If (2), the existing `check-unprovisioned` cron will pick it up once RC completes; verify the cron is actually firing.",
      },
      {
        needle: /\[DA-FAIL\]|DirectAdmin|da_unreachable|directadmin|DA-/i,
        hint: "DA returned an error on the create-user / suspend / delete call. Check the DA admin panel is reachable and the CSF / firewall / API allowlist still includes Cloud Run's NAT egress IP 34.14.59.128.",
      },
      {
        needle: /username collisions exhausted/i,
        hint: "DA username generator hit 3 consecutive collisions. Probably the email-derived prefix is unusually common — pick a different generation strategy or extend the retry budget.",
      },
    ],
  },
  {
    id: "zoho",
    label: "Zoho Books",
    signatures: [
      {
        needle: /\(code 1016\)|some of the taxes have been deleted/i,
        hint: "A tax_id this code is sending to Zoho is no longer registered in the org. Run a read-only Zoho probe (GET /api/v3/settings/taxes), confirm the active GST18 / IGST18 IDs match `ZOHO_TAX_ID_GST18` / `ZOHO_TAX_ID_IGST18` in .env.local AND in deploy-cloud-run.sh's ENV_VARS line. Redeploy after fixing.",
      },
      {
        needle: /\(code 3062\)|duplicate.*contact_name/i,
        hint: "Zoho rejected a createContact because the customer name already exists in the org. The proactive name-based lookup fix from dms-00177-g9k should handle this — check `lib/zohobooks/invoices.ts` getOrCreateContact path.",
      },
      {
        needle: /\(code 3057\)|gstin.*required/i,
        hint: "Zoho rejected the invoice because customer GSTIN is required at this place_of_supply. Verify the contact has gst_no set OR set the customer as 'consumer' / 'business_none'.",
      },
      {
        needle: /\(code 3032\)|tax.*mismatch|invalid tax_id/i,
        hint: "Inter-state vs intra-state tax mismatch (CGST+SGST vs IGST). The createInvoice fallback should auto-retry with the swapped tax_id — check `lib/zohobooks/invoices.ts` line ~180 GST-mismatch fallback.",
      },
      {
        needle: /Zoho|zohoapis|invoice_id|creation_failed/i,
        hint: "Generic Zoho Books API failure. Click 'Re-sync' on the affected order from /admin/invoices to retry — the actual rejection reason is in the toast / server log.",
      },
    ],
  },
  {
    id: "resellerclub",
    label: "ResellerClub",
    signatures: [
      {
        needle: /resellerclub|httpapi\.com|orderid.*not.*found|RC-/i,
        hint: "ResellerClub API error on domain registration / DNS / transfer. Check ResellerClub credentials (RESELLERCLUB_ID / RESELLERCLUB_RESELLER_ID / RESELLERCLUB_SECRET in Secret Manager) and the API allowlist on RC's end.",
      },
    ],
  },
  {
    id: "razorpay",
    label: "Razorpay",
    signatures: [
      {
        needle: /\[RECURRING-CHARGE\] ABANDONED|recurring charge abandoned/i,
        hint: "A Tokens-flow MIT charge was abandoned. HARD RULE: 1 attempt then suspend, applied UNIFORMLY to both trial-to-paid conversions AND renewals. The Hosting is now status='expired' + DA-suspended + the customer was emailed. Recovery requires a new CIT auth (re-subscribe). The admin dashboard at `/admin/recurring-charges` differentiates the two paths visually for triage (purple text = trial-conversion fail, blue text = renewal fail) — the technical policy is identical but the operational follow-up may differ (a long-term-customer's mandate dying may warrant outreach; a trial-conversion fail usually doesn't).",
      },
      {
        needle: /\[RECURRING-CHARGE\]|MIT charge|mandate.*revoke/i,
        hint: "A Tokens-flow MIT recurring charge failed. Under the current hard 1-attempt policy, this row should already be in status='abandoned' rather than 'failed' — `status='failed'` rows would only appear if a row was created under the older soft-grace policy (pre-this-commit) or if an operator manually edited the row. Most common root causes: card declined (insufficient funds / blocked card), customer revoked UPI mandate in their bank app, transient Razorpay 500. Open `/admin/recurring-charges` to see the row's `lastError` + pivot to Razorpay dashboard via the shown customerId/tokenId.",
      },
      {
        needle: /razorpay|BAD_REQUEST_ERROR|order_.*not_found|webhook.*signature/i,
        hint: "Razorpay API error or webhook signature mismatch. Verify RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET in Secret Manager and that the key is in the right mode (test vs live) for this environment.",
      },
    ],
  },
  {
    id: "email",
    label: "Email / SMTP",
    signatures: [
      {
        needle: /smtp|nodemailer|EAUTH|EENVELOPE|550 |551 |552 |553 /i,
        hint: "Outbound email failure. Check SMTP_HOST / SMTP_USER / SMTP_PASS in Secret Manager, look at the SMTP provider's rate-limit or reputation dashboard, and verify the FROM_EMAIL domain's SPF/DKIM are intact.",
      },
    ],
  },
  {
    id: "auth",
    label: "Authentication",
    signatures: [
      {
        needle: /TooManyRequests.*login|rate limit exceeded for.*from|CredentialsSignin|InvalidTotpCode|JWT.*malformed|jwt expired/i,
        hint: "Login / 2FA / JWT issue. A spike in rate-limit messages usually means brute-force traffic — confirm IPs aren't legitimate users before tightening. Repeated 'jwt expired' across many users would suggest NEXTAUTH_SECRET rotation drift.",
      },
    ],
  },
  {
    id: "background",
    label: "Background Jobs",
    signatures: [
      {
        needle: /cron|scheduler|worker|daily-scheduler|sync-zoho-invoice|check-unprovisioned/i,
        hint: "Cron / worker failure. The endpoint typically requires x-cron-secret — if many fail with the same secret-mismatch message, the CRON_SECRET in Secret Manager may have rotated out of sync with Google Cloud Scheduler.",
      },
    ],
  },
  {
    // Application-layer failures — internal bugs in our own code, NOT
    // upstream-service errors. Added 2026-07-02 after the 7-layer
    // manual-flow-trial chain (dms-00222 → dms-00232) surfaced a class of
    // 500s that never landed on the dashboard because they didn't match
    // any upstream-provider signature. The trial-signup failures were
    // Mongoose ValidatorError + case-mismatch DB lookups returning null +
    // missing schema fields — internal, but customer-facing 500s that
    // operators need to see. Signatures target the exact shapes observed.
    id: "application",
    label: "Application",
    signatures: [
      {
        needle: /ValidatorError|validation failed:|is not a valid enum value|Cast to \w+ failed/i,
        hint: "Mongoose schema-layer rejection. Common causes: (a) an enum field received a value not in the schema's enum list (the ORDER-MANDATEMODE-MANUAL bug from dms-00227 was this shape); (b) a required field is missing; (c) a cast (e.g. String → ObjectId) failed. Fix: either extend the schema's enum to include the value, or fix the caller. When adding a new value to an enum-like field, grep ALL callers that set that field AND every schema/type that declares the allowed values in the SAME commit.",
      },
      {
        needle: /Failed to (generate payment targets|create payment order)/i,
        hint: "The `/api/payments/create-order` route reached its no-payment-target throw. Usually means an upstream branch (Manual / Tokens / Subscription) threw silently and the outer catch surfaced this generic error. Check `serverLogger.error` entries with `[CREATE-ORDER]` prefix in the same window for the actual root cause — often a schema validation, case-mismatch, or missing helper import.",
      },
      {
        needle: /Cannot read propert(y|ies) of (undefined|null)|is not a function|TypeError:/i,
        hint: "Runtime TypeError — usually a code bug (accessing a field on a null/undefined value or calling a non-function). Search the stack trace for the file:line. Repeats of the same TypeError across multiple requests are a solid regression indicator; investigate what changed in the last deploy.",
      },
      {
        needle: /\[CREATE-ORDER\]|\[CART\]|\[CHECKOUT\]|\[TRIAL-|\[PROVISIONER\]/i,
        hint: "An internal payment / cart / checkout / trial / provisioner code path emitted an ERROR log. Search the exemplar message for the specific `[TAG]` prefix + follow the route/service file it names. These are internal-code bugs, not upstream failures — fix in code + redeploy.",
      },
      {
        needle: /buffering timed out|MongooseError|connection.*closed|MongoServerError/i,
        hint: "MongoDB connection / query failure. `buffering timed out after 10000ms` is the cold-start signature — a Cloud Run container woke without connectDB() having run. Check the specific route/service module is calling `await connectDB()` before its first query (the PROVISIONER-CONNECTDB-COLD-START-FIX from dms-00235 was this shape).",
      },
    ],
  },
];

function classify(errorText: string): { provider: ProviderId; label: string; hint?: string } {
  for (const p of PROVIDERS) {
    for (const sig of p.signatures) {
      if (sig.needle.test(errorText)) {
        return { provider: p.id, label: p.label, hint: sig.hint };
      }
    }
  }
  return { provider: "unknown", label: "Unclassified" };
}

/**
 * Look up a hint within ONE provider's signatures only. Used when
 * `log.service` has already told us which provider bucket the entry
 * belongs on — we don't want a keyword collision with another provider
 * (e.g. "Razorpay order creation failed" matching razorpay's generic
 * signature) to override that assignment or attach the wrong hint.
 */
function hintForProvider(errorText: string, providerId: ProviderId): string | undefined {
  const p = PROVIDERS.find((x) => x.id === providerId);
  if (!p) return undefined;
  for (const sig of p.signatures) {
    if (sig.needle.test(errorText)) return sig.hint;
  }
  return undefined;
}

/**
 * Normalise the error string into a stable bucket key so similar messages
 * (e.g. "License is limited to 2 accounts, and you currently have 2" vs
 * the same with a different number) cluster together. Strategy: lowercase,
 * collapse whitespace, strip trailing punctuation, strip digits to "N",
 * keep first 120 chars.
 */
function bucketKey(errorText: string): string {
  return errorText
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\d+/g, "N")
    .replace(/<br\s*\/?>/g, "")
    .trim()
    .slice(0, 120);
}

interface AffectedOrder {
  orderId: string;
  userEmail?: string;
  userName?: string;
  amount: number;
  createdAt: string;
  domainName?: string;
  itemType?: string;
}

interface ErrorPattern {
  exemplarMessage: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  hint?: string;
  affectedOrders: AffectedOrder[];
}

interface ProviderHealth {
  id: ProviderId;
  label: string;
  totalErrors: number;
  patterns: ErrorPattern[];
}

export async function GET(request: NextRequest) {
  try {
    const adminUser = await AuthService.getAdminFromRequest(request);
    if (!adminUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const windowDays = Math.max(1, Math.min(90, Number(searchParams.get("windowDays") || "30")));
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    await connectDB();

    // Collect (provider, bucketKey) → ErrorPattern accumulator.
    const buckets = new Map<string, ErrorPattern & { provider: ProviderId; providerLabel: string }>();

    function record(args: {
      errorText: string;
      orderId: string;
      userEmail?: string;
      userName?: string;
      amount: number;
      createdAt: Date;
      domainName?: string;
      itemType?: string;
    }) {
      const { provider, label, hint } = classify(args.errorText);
      const key = `${provider}::${bucketKey(args.errorText)}`;
      const existing = buckets.get(key);
      const occurred = args.createdAt.toISOString();
      if (existing) {
        existing.count += 1;
        if (occurred < existing.firstSeen) existing.firstSeen = occurred;
        if (occurred > existing.lastSeen) existing.lastSeen = occurred;
        if (existing.affectedOrders.length < 20) {
          existing.affectedOrders.push({
            orderId: args.orderId,
            userEmail: args.userEmail,
            userName: args.userName,
            amount: args.amount,
            createdAt: occurred,
            domainName: args.domainName,
            itemType: args.itemType,
          });
        }
      } else {
        buckets.set(key, {
          provider,
          providerLabel: label,
          exemplarMessage: args.errorText.slice(0, 500),
          count: 1,
          firstSeen: occurred,
          lastSeen: occurred,
          hint,
          affectedOrders: [
            {
              orderId: args.orderId,
              userEmail: args.userEmail,
              userName: args.userName,
              amount: args.amount,
              createdAt: occurred,
              domainName: args.domainName,
              itemType: args.itemType,
            },
          ],
        });
      }
    }

    // Type the lean() results so we don't have to chain casts through every
    // record() call. Mongoose's leaned-doc type is a generic shape; the
    // projection above pins which fields are present.
    interface LeanedFailedDomainsOrder {
      orderId: string;
      userEmail?: string;
      userName?: string;
      amount: number;
      createdAt: Date;
      domains?: Array<{ status?: string; error?: string; domainName?: string; itemType?: string }>;
    }
    interface LeanedZohoStuckOrder {
      orderId: string;
      userEmail?: string;
      userName?: string;
      amount: number;
      createdAt: Date;
    }

    // 1. Failed domain / hosting line items
    const ordersWithFailedDomains = (await Order.find(
      {
        createdAt: { $gte: since },
        "domains.status": "failed",
        "domains.error": { $exists: true, $ne: "" },
      },
      {
        orderId: 1,
        userEmail: 1,
        userName: 1,
        amount: 1,
        createdAt: 1,
        domains: 1,
      }
    )
      .sort({ createdAt: -1 })
      .lean()) as unknown as LeanedFailedDomainsOrder[];

    for (const o of ordersWithFailedDomains) {
      const domains = o.domains ?? [];
      for (const d of domains) {
        if (d.status === "failed" && d.error && d.error.trim()) {
          record({
            errorText: d.error,
            orderId: o.orderId,
            userEmail: o.userEmail,
            userName: o.userName,
            amount: o.amount,
            createdAt: o.createdAt,
            domainName: d.domainName,
            itemType: d.itemType,
          });
        }
      }
    }

    // 2. Zoho-side: orders with creation_failed sentinel
    const zohoStuckOrders = (await Order.find(
      {
        createdAt: { $gte: since },
        zohoInvoiceId: "creation_failed",
      },
      {
        orderId: 1,
        userEmail: 1,
        userName: 1,
        amount: 1,
        createdAt: 1,
      }
    )
      .sort({ createdAt: -1 })
      .lean()) as unknown as LeanedZohoStuckOrder[];

    for (const o of zohoStuckOrders) {
      record({
        errorText: "Zoho Books invoice creation_failed (no detail captured — click Re-sync from /admin/invoices to retry; the toast will surface the actual reason from dms-00188-lfm onwards)",
        orderId: o.orderId,
        userEmail: o.userEmail,
        userName: o.userName,
        amount: o.amount,
        createdAt: o.createdAt,
      });
    }

    // 3. SystemLog ERROR entries — every serverLogger.error() call lands
    // here via the /api/v1/admin/log-error forwarder (CSRF gate fix shipped
    // earlier today via dms-00190-jmx so this now reliably populates).
    // Far broader coverage than the Order-based sources alone: email
    // failures, auth issues, cron-job errors, RC API timeouts, etc. We
    // classify each entry by its `service` field first, fall back to the
    // existing keyword classifier when service is unset.
    interface LeanedSystemLog {
      _id: unknown;
      message: string;
      source?: string;
      service?: string;
      stack?: string;
      statusCode?: number;
      createdAt: Date;
    }

    const recentErrorLogs = (await SystemLog.find(
      {
        level: "error",
        createdAt: { $gte: since },
        // Exclude client-boundary errors — those are browser-side React
        // crashes, usually a customer-environment quirk (extension,
        // ad-blocker, broken cache). Keep them out of the operator view
        // to avoid drowning the real upstream signals.
        source: { $ne: "Client Boundary" },
      },
      {
        message: 1,
        source: 1,
        service: 1,
        stack: 1,
        statusCode: 1,
        createdAt: 1,
      }
    )
      .sort({ createdAt: -1 })
      .limit(500)
      .lean()) as unknown as LeanedSystemLog[];

    for (const log of recentErrorLogs) {
      const errText = (log.message || "").trim();
      if (!errText) continue;

      // Classification order:
      //   (a) If log.service maps to a specific provider → that's the
      //       bucket assignment; look up the hint from ONLY that
      //       provider's signatures (avoids razorpay-generic-signature
      //       stealing an application-code error just because the string
      //       "Razorpay" appears in the message).
      //   (b) Else fall through to whole-PROVIDERS classify() which does
      //       both provider assignment + hint lookup by first-match.
      let classified: { provider: ProviderId; label: string; hint?: string };
      const serviceMapped = log.service
        ? SERVICE_TO_PROVIDER[log.service.toLowerCase()]
        : undefined;
      if (serviceMapped && serviceMapped !== "unknown") {
        const cfg = PROVIDERS.find((p) => p.id === serviceMapped);
        classified = {
          provider: serviceMapped,
          label: cfg?.label ?? serviceMapped,
          hint: hintForProvider(errText, serviceMapped),
        };
      } else {
        classified = classify(errText);
      }

      const key = `${classified.provider}::${bucketKey(errText)}`;
      const occurred = log.createdAt.toISOString();
      const existing = buckets.get(key);
      if (existing) {
        existing.count += 1;
        if (occurred < existing.firstSeen) existing.firstSeen = occurred;
        if (occurred > existing.lastSeen) existing.lastSeen = occurred;
        // SystemLog entries have no order context — we don't push to
        // affectedOrders (those are for order-derived sources).
      } else {
        buckets.set(key, {
          provider: classified.provider,
          providerLabel: classified.label,
          exemplarMessage: errText.slice(0, 500),
          count: 1,
          firstSeen: occurred,
          lastSeen: occurred,
          hint: classified.hint,
          affectedOrders: [],
        });
      }
    }

    // 4. RecurringChargeAttempt rows with status='failed' or 'abandoned'.
    // Querying the canonical state collection directly (rather than relying
    // on serverLogger calls landing in SystemLog with the right strings)
    // means coverage is bulletproof: if a row exists, the operator sees it.
    // Each row becomes one synthetic error entry that the Razorpay
    // provider's RECURRING-CHARGE signatures pick up + classify with the
    // dedicated hint pointing at /admin/recurring-charges.
    try {
      const { default: RecurringChargeAttempt } = await import(
        "@/models/RecurringChargeAttempt"
      );
      const failedAttempts = (await RecurringChargeAttempt.find(
        {
          status: { $in: ["failed", "abandoned"] },
          createdAt: { $gte: since },
        },
        {
          status: 1,
          attemptCount: 1,
          lastError: 1,
          hostingId: 1,
          createdAt: 1,
          abandonedAt: 1,
          dueDate: 1,
        }
      )
        .sort({ createdAt: -1 })
        .limit(500)
        .lean()) as unknown as Array<{
        _id: { toString(): string };
        status: "failed" | "abandoned";
        attemptCount: number;
        lastError?: string | null;
        hostingId: { toString(): string };
        createdAt: Date;
        abandonedAt?: Date | null;
        dueDate: Date;
      }>;

      for (const att of failedAttempts) {
        const errMsg = att.lastError || "(no error captured)";
        const statusLabel = att.status === "abandoned" ? "ABANDONED" : "FAILED";
        // Synthesised message — the `[RECURRING-CHARGE]` prefix routes this
        // to the new Razorpay-recurring signature in PROVIDERS (above).
        const errorText = `[RECURRING-CHARGE] ${statusLabel} attempt ${att.attemptCount} for Hosting ${att.hostingId.toString().slice(-8)}: ${errMsg}`;
        const { provider, label, hint } = classify(errorText);
        const key = `${provider}::${bucketKey(errorText)}`;
        const occurred = att.createdAt.toISOString();
        const existing = buckets.get(key);
        if (existing) {
          existing.count += 1;
          if (occurred < existing.firstSeen) existing.firstSeen = occurred;
          if (occurred > existing.lastSeen) existing.lastSeen = occurred;
        } else {
          buckets.set(key, {
            provider,
            providerLabel: label,
            exemplarMessage: errorText.slice(0, 500),
            count: 1,
            firstSeen: occurred,
            lastSeen: occurred,
            hint,
            affectedOrders: [],
          });
        }
      }
    } catch (rcaErr) {
      // Don't let RCA query failures crash the whole page — the existing
      // Order + SystemLog sources stay intact.
      serverLogger.warn(
        `[integration-health] RecurringChargeAttempt query failed: ${rcaErr instanceof Error ? rcaErr.message : String(rcaErr)}`
      );
    }

    // Roll up buckets into provider groups. `unknown` is always present as
    // the fallback catch-all. A defensive check in the loop below routes
    // any bucket with an unseeded provider id into `unknown` rather than
    // crashing — the previous `providerMap.get(b.provider)!` non-null
    // assertion was a runtime landmine: SERVICE_TO_PROVIDER could produce
    // an id (e.g. legacy 'application' mappings before that provider was
    // seeded here) that had no map entry, and the ensuing TypeError got
    // silently swallowed by the outer catch as a generic 500.
    const providerMap = new Map<ProviderId, ProviderHealth>();
    for (const cfg of PROVIDERS) {
      providerMap.set(cfg.id, { id: cfg.id, label: cfg.label, totalErrors: 0, patterns: [] });
    }
    providerMap.set("unknown", { id: "unknown", label: "Unclassified", totalErrors: 0, patterns: [] });

    for (const b of buckets.values()) {
      const group = providerMap.get(b.provider) ?? providerMap.get("unknown")!;
      group.totalErrors += b.count;
      group.patterns.push({
        exemplarMessage: b.exemplarMessage,
        count: b.count,
        firstSeen: b.firstSeen,
        lastSeen: b.lastSeen,
        hint: b.hint,
        affectedOrders: b.affectedOrders,
      });
    }
    for (const group of providerMap.values()) {
      group.patterns.sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
    }

    const providers = Array.from(providerMap.values())
      .filter((p) => p.id !== "unknown" || p.totalErrors > 0)
      .sort((a, b) => b.totalErrors - a.totalErrors);

    return NextResponse.json({
      windowDays,
      generatedAt: new Date().toISOString(),
      providers,
    });
  } catch (error) {
    serverLogger.error("[INTEGRATION-HEALTH] Error:", error);
    return NextResponse.json({ error: "Failed to load integration health" }, { status: 500 });
  }
}
