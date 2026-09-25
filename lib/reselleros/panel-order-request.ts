/**
 * Turn "the signed-in customer wants X" into ResellerOS's panel-order body.
 *
 * Identity — the DMS account id, name, email and phone — comes from the User
 * record the session resolved, NEVER from the browser. A body that could name
 * its own email could buy, and receive the bill, as somebody else. What the
 * browser may send is only what it is choosing: the product, the domain, and
 * the billing details the customer typed (company, GSTIN, registrant address).
 *
 * No price travels in either direction here. ResellerOS prices every line
 * itself (domains at the LIVE ResellerClub price); DMS's own hosting and domain
 * prices are not inputs to what the customer pays.
 */
import { z } from "zod";
import { isProvisionableDomain } from "@/lib/validation/hosting-domain";
import type { PanelOrderLine, PanelOrderRequest } from "./panel-order";

const addressSchema = z.object({
  line1: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(80),
  state: z.string().trim().min(1).max(80),
  zipcode: z.string().trim().min(3).max(12),
  /** ISO 3166 two-letter code — ResellerOS takes at most two characters. */
  country: z.string().trim().length(2).optional(),
});

export const panelPurchaseSchema = z.object({
  purchase: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("hosting"),
      planId: z.enum(["starter", "standard", "plus"]),
      cycle: z.enum(["monthly", "yearly"]),
      /** The domain the hosting is set up on. */
      domain: z.string().trim().min(3).max(253),
    }),
    z.object({
      kind: z.literal("domain"),
      /** The full name to register, e.g. example.in. */
      domain: z.string().trim().min(3).max(253),
    }),
  ]),
  companyName: z.string().trim().min(2).max(200),
  gstin: z.string().trim().max(20).optional(),
  address: addressSchema.optional(),
});

export type PanelPurchase = z.infer<typeof panelPurchaseSchema>;

/** The User fields this reads. Typed narrowly so a test needs no Mongoose doc. */
export interface PanelBuyer {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

export type BuildResult =
  | { ok: true; request: PanelOrderRequest }
  | { ok: false; message: string; field: "name" | "phone" | "email" | "domain" | "address" | "account" };

const SETTINGS = "Settings (Dashboard → Settings)";

export function buildPanelOrderRequest(buyer: PanelBuyer, body: PanelPurchase): BuildResult {
  const dmsUserId = String(buyer.id);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(dmsUserId)) {
    return { ok: false, field: "account", message: "We couldn't identify your account for this purchase. Nothing was charged. Please sign out, sign in again and retry." };
  }
  const fullName = `${buyer.firstName ?? ""} ${buyer.lastName ?? ""}`.replace(/\s+/g, " ").trim();
  if (fullName.length < 2) {
    return { ok: false, field: "name", message: `Your account has no name on it, and a bill needs one. Nothing was charged. Add your name in ${SETTINGS}, then try again.` };
  }
  const email = (buyer.email ?? "").trim();
  if (!email) {
    return { ok: false, field: "email", message: "Your account has no email address, so we'd have nowhere to send your bill. Nothing was charged. Please contact support." };
  }
  const phone = (buyer.phone ?? "").replace(/[\s-]/g, "");
  if (phone.length < 10 || phone.length > 20) {
    return { ok: false, field: "phone", message: `Your account has no mobile number, and the order needs one. Nothing was charged. Add it in ${SETTINGS}, then try again.` };
  }

  const domain = body.purchase.domain.toLowerCase();
  if (!isProvisionableDomain(domain)) {
    return {
      ok: false,
      field: "domain",
      message: `"${body.purchase.domain}" isn't a domain name we can use. Nothing was charged. Enter the full name, for example yourbusiness.in.`,
    };
  }

  const lines: PanelOrderLine[] = [];
  let hostingDomain: string | undefined;
  if (body.purchase.kind === "hosting") {
    lines.push({ sku: `hosting:${body.purchase.planId}`, qty: 1, cycle: body.purchase.cycle });
    hostingDomain = domain;
  } else {
    const tld = domain.slice(domain.indexOf(".") + 1);
    // One year, quantity 1: ResellerOS's contract for a domain line.
    lines.push({ sku: `domain:${tld}`, qty: 1, domain });
    if (!body.address) {
      return {
        ok: false,
        field: "address",
        message: "A domain is registered in your name, so the registry needs your postal address. Nothing was charged. Fill in the address below and try again.",
      };
    }
  }

  const gstin = body.gstin?.trim().toUpperCase();
  const request: PanelOrderRequest = {
    dmsUserId,
    fullName,
    companyName: body.companyName.trim(),
    email,
    phone,
    ...(gstin ? { gstin } : {}),
    ...(hostingDomain ? { domain: hostingDomain } : {}),
    lines,
    ...(body.address ? { address: { ...body.address, country: (body.address.country ?? "IN").toUpperCase() } } : {}),
  };
  return { ok: true, request };
}
