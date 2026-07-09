export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import Domain from "@/models/Domain";
import { findOrderByDomain, findOrderDomain } from "@/lib/services/orders";
import { diagnoseDomainRegistrar } from "@/lib/resellerclub/registration";
import { serverLogger } from "@/lib/server-logger";

/**
 * GET /api/admin/domains/rc-diagnostic?domainName=example.com
 *
 * Admin-only registrar-ownership probe. Confirms whether ResellerClub lets the
 * active reseller account manage a domain — used to diagnose "You are not
 * allowed to perform this action" on nameserver changes. Reports the order-id
 * stored in our Domain + Order records, what RC returns for the domain by
 * name, and whether RC recognises the stored order-id — then a plain-English
 * verdict. Read-only; makes no changes.
 */
export async function GET(request: NextRequest) {
  try {
    const admin = await AuthService.getAdminFromRequest(request);
    if (!admin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const domainName = request.nextUrl.searchParams.get("domainName")?.trim().toLowerCase();
    if (!domainName) {
      return NextResponse.json({ error: "domainName is required" }, { status: 400 });
    }

    await connectDB();

    // Stored order-ids from both places we persist them.
    const domainDoc = await Domain.findOne({ domainName }).lean<{
      resellerClubOrderId?: string;
      nameservers?: string[];
      status?: string;
    }>();
    const order = await findOrderByDomain(domainName);
    const orderDomain = order ? findOrderDomain(order, domainName) : null;
    const orderRecordOrderId = (orderDomain as { resellerClubOrderId?: string } | null)?.resellerClubOrderId;
    const domainRecordOrderId = domainDoc?.resellerClubOrderId;
    const storedOrderId = orderRecordOrderId || domainRecordOrderId || null;

    const probe = await diagnoseDomainRegistrar(domainName, storedOrderId);

    // Verdict
    let verdict: string;
    let managedByThisAccount: boolean;
    if (!probe.byName.ok && probe.byStoredOrderId.tested && !probe.byStoredOrderId.ok) {
      managedByThisAccount = false;
      verdict = `ResellerClub does not recognise this domain under the active reseller account (order lookup by name failed${probe.byStoredOrderId.rawMessage ? `; stored order-id rejected: "${probe.byStoredOrderId.rawMessage}"` : ""}). The domain is likely registered under a different / legacy RC account, or the stored order-id is wrong. Nameserver changes via this API will keep failing until the order is re-linked to the correct account.`;
    } else if (probe.byName.ok && storedOrderId && probe.byName.orderId && probe.byName.orderId !== storedOrderId) {
      managedByThisAccount = true;
      verdict = `Order-id MISMATCH: we stored "${storedOrderId}" but ResellerClub reports "${probe.byName.orderId}" for this domain. Re-link the stored order-id to the RC value, then nameserver changes should work.`;
    } else if (probe.byName.ok && probe.byStoredOrderId.ok) {
      managedByThisAccount = true;
      verdict = `OK — ResellerClub recognises this domain and the stored order-id under the active account. If nameserver changes still fail, check the domain's order status (suspended / transfer-locked / pending).`;
    } else if (probe.byName.ok && !storedOrderId) {
      managedByThisAccount = true;
      verdict = `RC recognises the domain (order-id "${probe.byName.orderId}") but we have NO stored order-id for it. Persist the RC order-id to the Order/Domain record so management calls can target it.`;
    } else {
      managedByThisAccount = false;
      verdict = `Inconclusive — RC lookup by name failed${probe.byName.rawMessage ? ` ("${probe.byName.rawMessage}")` : ""} and no stored order-id to test. Could be a transient RC API error; retry, or verify the domain in the RC control panel.`;
    }

    return NextResponse.json({
      domainName,
      stored: {
        orderRecordOrderId: orderRecordOrderId ?? null,
        domainRecordOrderId: domainRecordOrderId ?? null,
        effectiveOrderId: storedOrderId,
        currentNameservers: domainDoc?.nameservers ?? [],
        domainStatus: domainDoc?.status ?? null,
      },
      resellerclub: probe,
      managedByThisAccount,
      verdict,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    serverLogger.error("[rc-diagnostic] error:", error);
    return NextResponse.json({ error: "Diagnostic failed" }, { status: 500 });
  }
}
