/**
 * Phase 2 integration: fetches the Support Panel (DSP)'s admin-facing ticket
 * list, merged into the Customer Panel's admin Support Tickets page
 * alongside its own legacy Mongo-backed tickets. Read-only, server-to-server.
 *
 * Status vocabulary mismatch: DSP's ticket status is 'open'|'pending'|'closed';
 * the Customer Panel's admin UI has four tabs: open|in_progress|resolved|closed.
 * Mapping: open->open, in_progress->pending, closed->closed. There's no DSP
 * equivalent of "resolved" — that tab only ever shows legacy tickets.
 *
 * Best-effort: DSP being unreachable should never break this admin page, so
 * failures resolve to an empty list instead of throwing.
 */

import { serverLogger } from "@/lib/server-logger";

export interface DspAdminTicket {
  _id: string;
  ticketNumber: string;
  subject: string;
  category: string;
  status: "open" | "in_progress" | "resolved" | "closed";
  priority: string;
  userEmail: string;
  userName: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  lastMessage: null;
  source: "support-panel";
}

const TAB_TO_DSP_STATUS: Record<string, "open" | "pending" | "closed" | undefined> = {
  all: undefined,
  open: "open",
  in_progress: "pending",
  resolved: undefined, // DSP has no equivalent — signals "skip the DSP fetch"
  closed: "closed",
};

const DSP_TO_TAB_STATUS: Record<string, DspAdminTicket["status"]> = {
  open: "open",
  pending: "in_progress",
  closed: "closed",
};

const DSP_PRIORITY_TO_PORTAL: Record<string, string> = {
  urgent: "high",
  high: "high",
  medium: "medium",
  normal: "medium",
  low: "low",
};

export async function getDspTicketsForAdmin(tab: string): Promise<DspAdminTicket[]> {
  // "resolved" has no DSP equivalent, and skip the call entirely for "all"'s
  // sibling case where the tab explicitly maps to undefined-but-not-"all".
  if (tab === "resolved") return [];

  const apiUrl = process.env.DSP_API_URL;
  const apiKey = process.env.DSP_INTEGRATION_API_KEY;
  if (!apiUrl || !apiKey) {
    serverLogger.warn("[support-tickets-admin] DSP_API_URL/DSP_INTEGRATION_API_KEY not configured — skipping");
    return [];
  }

  const dspStatus = TAB_TO_DSP_STATUS[tab];
  const qs = new URLSearchParams({ limit: "50" });
  if (dspStatus) qs.set("status", dspStatus);

  try {
    const url = `${apiUrl.replace(/\/$/, "")}/api/integrations/customer-portal/tickets?${qs.toString()}`;
    const res = await fetch(url, {
      headers: { "X-Integration-Key": apiKey },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      serverLogger.warn(`[support-tickets-admin] DSP returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    const rows: Array<{
      id: number;
      subject: string;
      status: string;
      priority: string;
      created_at: string;
      updated_at: string;
      customer_name: string;
      customer_email: string;
      message_count: number;
    }> = data.tickets ?? [];

    return rows.map((t) => ({
      _id: `dsp-${t.id}`,
      ticketNumber: `DSP-${t.id}`,
      subject: t.subject,
      category: "other",
      status: DSP_TO_TAB_STATUS[t.status] ?? "open",
      priority: DSP_PRIORITY_TO_PORTAL[t.priority] ?? "low",
      userEmail: t.customer_email,
      userName: t.customer_name,
      createdAt: new Date(t.created_at),
      updatedAt: new Date(t.updated_at),
      messageCount: t.message_count,
      lastMessage: null,
      source: "support-panel" as const,
    }));
  } catch (error) {
    serverLogger.warn("[support-tickets-admin] request failed", error);
    return [];
  }
}
