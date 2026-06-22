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

      // Classify: explicit `service` field first (set by the call site),
      // else fall through to message-keyword matching.
      let providerId: ProviderId | undefined;
      let providerLabel: string | undefined;
      let hint: string | undefined;
      if (log.service) {
        const mapped = SERVICE_TO_PROVIDER[log.service.toLowerCase()];
        if (mapped) {
          providerId = mapped;
          // Find the provider's display label from PROVIDERS, or fall back.
          const cfg = PROVIDERS.find((p) => p.id === mapped);
          providerLabel = cfg?.label ?? mapped;
        }
      }
      const classified = providerId
        ? { provider: providerId, label: providerLabel!, hint }
        : classify(errText);

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

    // Roll up buckets into provider groups.
    const providerMap = new Map<ProviderId, ProviderHealth>();
    for (const cfg of PROVIDERS) {
      providerMap.set(cfg.id, { id: cfg.id, label: cfg.label, totalErrors: 0, patterns: [] });
    }
    providerMap.set("unknown", { id: "unknown", label: "Unclassified", totalErrors: 0, patterns: [] });

    for (const b of buckets.values()) {
      const group = providerMap.get(b.provider)!;
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
