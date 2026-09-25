/**
 * Map DMS cart lines to ResellerOS panel-order lines.
 *
 * Owner, 25 Sep 2026 ("Route through ResellerOS"): the DMS cart stays —
 * HostingUpsell, DomainCrossSell, saved carts, several items at once — but
 * its Pay sends every PAID line to ResellerOS's `POST /api/dms/panel-order`
 * (lib/reselleros/panel-order.ts). ResellerOS prices each line itself; the
 * cart's prices never travel.
 *
 * A line is mapped only when its meaning is certain. Anything else is refused
 * with a message naming the line — never guessed (AGENTS.md §2):
 *   hosting  → `hosting:<starter|standard|plus>` + cycle (yearly/monthly)
 *   domain   → `domain:<tld>`, qty 1, the exact `domain` (one year: that is
 *              what ResellerOS sells; a multi-year line is refused)
 *   mailbox  → `mailbox:anutech` (the DMS cart has no such line today)
 *
 * ResellerOS's contract has ONE `domain` for hosting, so a cart may hold at
 * most one hosting line, and it must be linked to a real domain.
 *
 * A ₹0 trial line is not a paid line and never goes to ResellerOS (its
 * panel-order refuses trials); a cart holding a trial and paid lines together
 * is refused, as it always was.
 */
import type { PanelOrderLine } from "./panel-order";
import { isProvisionableDomain, hostingItemDomain } from "@/lib/validation/hosting-domain";

/** The fields of a cart line this reads — narrow, so a test needs no store. */
export interface CartLineLike {
  domainName: string;
  itemType?: "domain" | "hosting" | string;
  registrationPeriod?: number;
  periodUnit?: string;
  billingCycle?: "monthly" | "yearly" | string;
  linkedDomain?: string;
  isTrial?: boolean;
  tldAttributes?: Record<string, string>;
  hostingPlan?: { id?: string; planId?: string; name?: string };
}

export type CartMapping =
  | { ok: true; lines: PanelOrderLine[]; hostingDomain: string | null; needsAddress: boolean; summary: string[] }
  | { ok: false; message: string };

const SELLABLE_HOSTING = new Set(["starter", "standard", "plus"]);

function hostingCycle(line: CartLineLike): "monthly" | "yearly" | null {
  if (line.billingCycle === "monthly" || line.billingCycle === "yearly") return line.billingCycle;
  if (line.periodUnit === "months" || line.periodUnit === undefined) {
    if (line.registrationPeriod === 12) return "yearly";
    if (line.registrationPeriod === 1) return "monthly";
  }
  return null;
}

export function mapCartToPanelOrder(items: readonly CartLineLike[]): CartMapping {
  if (items.length === 0) return { ok: false, message: "Your cart is empty." };
  if (items.some((i) => i.isTrial === true)) {
    return {
      ok: false,
      message:
        "We couldn't check out a free trial together with paid items. Nothing was charged. " +
        "Remove the trial or the other items, and check them out separately.",
    };
  }

  const lines: PanelOrderLine[] = [];
  const summary: string[] = [];
  let hostingDomain: string | null = null;
  let needsAddress = false;

  for (const item of items) {
    const kind = item.itemType ?? "domain";

    if (kind === "hosting") {
      const name = item.hostingPlan?.name ?? "Hosting";
      if (hostingDomain !== null) {
        return {
          ok: false,
          message: `Your cart has more than one hosting plan. Nothing was charged. Check out one hosting plan at a time — remove "${name}" and buy it separately.`,
        };
      }
      const planId = (item.hostingPlan?.id ?? item.hostingPlan?.planId ?? "").toLowerCase();
      if (!SELLABLE_HOSTING.has(planId)) {
        return {
          ok: false,
          message: `"${name}" can't be bought online. Nothing was charged. Remove it from your cart and contact support to buy it.`,
        };
      }
      const cycle = hostingCycle(item);
      if (!cycle) {
        return {
          ok: false,
          message: `We couldn't tell whether "${name}" is monthly or yearly. Nothing was charged. Remove it and add it again from Buy hosting.`,
        };
      }
      const domain = hostingItemDomain(item).trim().toLowerCase();
      if (!isProvisionableDomain(domain)) {
        return {
          ok: false,
          message: `"${name}" isn't linked to a domain yet. Nothing was charged. Choose the domain it's for in your cart, then check out.`,
        };
      }
      hostingDomain = domain;
      lines.push({ sku: `hosting:${planId}` as PanelOrderLine["sku"], qty: 1, cycle });
      summary.push(`${name} for ${domain} (${cycle === "yearly" ? "1 year" : "1 month"})`);
      continue;
    }

    if (kind === "domain") {
      const domain = item.domainName.trim().toLowerCase();
      if (!isProvisionableDomain(domain)) {
        return { ok: false, message: `"${item.domainName}" isn't a domain name we can register. Nothing was charged. Remove it from your cart.` };
      }
      const years = item.registrationPeriod ?? 1;
      if (years !== 1) {
        return {
          ok: false,
          message: `${domain} is set to ${years} years, and online registration is for 1 year at a time. Nothing was charged. Set it to 1 year in your cart, or contact support for a longer term.`,
        };
      }
      if (item.tldAttributes && Object.keys(item.tldAttributes).length > 0) {
        return {
          ok: false,
          message: `${domain} needs extra registry details that online checkout can't pass on. Nothing was charged. Remove it from your cart and contact support to register it.`,
        };
      }
      lines.push({ sku: `domain:${domain.slice(domain.indexOf(".") + 1)}`, qty: 1, domain });
      summary.push(`${domain} (1 year)`);
      needsAddress = true;
      continue;
    }

    if (kind === "mailbox") {
      lines.push({ sku: "mailbox:anutech", qty: 1 });
      summary.push("Anutech Mail");
      continue;
    }

    return {
      ok: false,
      message: `"${item.domainName}" is not something online checkout can sell. Nothing was charged. Remove it from your cart and contact support.`,
    };
  }

  return { ok: true, lines, hostingDomain, needsAddress, summary };
}
