/**
 * Phase 2 integration: fetches the customer's DSP (Support Panel) ticket
 * count for the "Active Tickets" dashboard card. Server-to-server, read-only
 * — does NOT create a DSP account for users who've never used Support (see
 * dsp/backend/src/integrations/customerPortalTicketSummary.js for why).
 *
 * Best-effort: DSP being unreachable/misconfigured should never break the
 * customer's own dashboard, so failures resolve to "no data" instead of
 * throwing.
 */

import { serverLogger } from "@/lib/server-logger";

export interface SupportTicketSummary {
  hasAccount: boolean;
  openTickets: number;
}

const FALLBACK: SupportTicketSummary = { hasAccount: false, openTickets: 0 };

export async function getSupportTicketSummary(dmsUserId: string): Promise<SupportTicketSummary> {
  const apiUrl = process.env.DSP_API_URL;
  const apiKey = process.env.DSP_INTEGRATION_API_KEY;
  if (!apiUrl || !apiKey) {
    serverLogger.warn("[support-ticket-summary] DSP_API_URL/DSP_INTEGRATION_API_KEY not configured — skipping");
    return FALLBACK;
  }

  try {
    const url = `${apiUrl.replace(/\/$/, "")}/api/integrations/customer-portal/ticket-count?dmsUserId=${encodeURIComponent(dmsUserId)}`;
    const res = await fetch(url, {
      headers: { "X-Integration-Key": apiKey },
      // Dashboard stats shouldn't hang waiting on a slow/unreachable DSP.
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      serverLogger.warn(`[support-ticket-summary] DSP returned ${res.status}`);
      return FALLBACK;
    }
    const data = await res.json();
    return {
      hasAccount: !!data.hasAccount,
      openTickets: Number(data.openTickets) || 0,
    };
  } catch (error) {
    serverLogger.warn("[support-ticket-summary] request failed", error);
    return FALLBACK;
  }
}
