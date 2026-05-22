/**
 * Per-item domain provisioner. Extracted from the H2 decomposition of
 * `provisionCartItems`. Owns the ResellerClub registration call, the
 * "already registered locally" short-circuit, and the success / pending /
 * failure / catch branches (each with subtly different orderDomain shape).
 *
 * Returns a shape the orchestrator pushes into its accumulator arrays —
 * the helper itself never touches the orchestrator's local state.
 */
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { serverLogger } from "@/lib/server-logger";
import Domain from "@/models/Domain";
import { calculateItemExpiration } from "@/lib/billing";
import { AUTOMATION_CONFIG } from "@/config/automation";
import {
  registerDomain as rcRegisterDomain,
  type RegisterDomainOutcome,
} from "@/lib/integrations/resellerclub";

import type { IUser } from "@/models/User";
import type { CartItem } from "@/lib/types";
import type { OrderDomain, RegistrationResult } from "./provisioner";

const FIRST_REMINDER_DAYS = Math.max(...AUTOMATION_CONFIG.REMINDER_DAYS);

export interface DomainProvisionContext {
  user: IUser;
  orderId: string;
  /** Needed for the "is this domain paired with hosting in the same cart?"
   * log line — doesn't change behaviour, just the log message. */
  cartItems: CartItem[];
  customerResult: { customerId: number; contactId: number };
}

export interface DomainProvisionResult {
  registrationResult: RegistrationResult;
  orderDomain: OrderDomain;
  /** Set when registration returned `success` (or when an active local
   * Domain row existed before we even hit ResellerClub). */
  successfulDomain?: string;
}

/**
 * Provision a single domain cart item. Pure return-value contract;
 * side-effects are limited to ResellerClub + the Domain collection.
 */
export async function provisionDomainItem(
  item: CartItem,
  ctx: DomainProvisionContext
): Promise<DomainProvisionResult> {
  const { user, orderId, cartItems, customerResult } = ctx;

  // Guard: skip registration if an active Domain record already exists for
  // this name. Prevents re-registering a domain that was soft-deleted and
  // then re-purchased.
  const existingActiveDomain = await Domain.findOne({
    domainName: item.domainName,
    deletedAt: null,
  }).lean();
  if (existingActiveDomain) {
    serverLogger.warn(
      `⚠️ [PAYMENT-VERIFY] Active domain record already exists for ${item.domainName}, skipping ResellerClub registration`
    );
    return {
      registrationResult: {
        domainName: item.domainName,
        status: "already_registered",
        itemType: "domain",
      },
      successfulDomain: item.domainName,
      orderDomain: {
        domainName: item.domainName,
        itemType: "domain",
        price: item.price,
        currency: item.currency || "INR",
        registrationPeriod: item.registrationPeriod || 1,
        periodUnit: item.periodUnit || "years",
        status: "registered",
        dnsProvider: "resellerclub",
        bookingStatus: [
          {
            step: "domain_registered",
            message: "Domain already active",
            timestamp: new Date(),
            progress: 100,
          },
        ],
      },
    };
  }

  serverLogger.info(`🔄 [PAYMENT-VERIFY] Registering domain: ${item.domainName}`);

  const domainBookingStatus: OrderDomain["bookingStatus"] = [
    { step: "payment_verified", message: "Payment verified successfully", timestamp: new Date(), progress: 20 },
    { step: "customer_created", message: "Setting up your account", timestamp: new Date(), progress: 40 },
    { step: "contact_created", message: "Account setup completed", timestamp: new Date(), progress: 60 },
  ];

  try {
    const isHostedInThisOrder = cartItems.some(
      (cartItem) =>
        cartItem.itemType === "hosting" &&
        (cartItem.linkedDomain === item.domainName ||
          cartItem.domainName === item.domainName)
    );
    serverLogger.info(
      isHostedInThisOrder
        ? `🌐 [PAYMENT-VERIFY] Domain ${item.domainName} is paired with Hosting. Using ResellerClub Default Nameservers per new policy.`
        : `🌐 [PAYMENT-VERIFY] Domain ${item.domainName} is Domain Only. Using ResellerClub Default Nameservers.`
    );

    const registrationNameservers: string[] | undefined = undefined;

    serverLogger.info(
      `🌐 [PAYMENT-VERIFY] Starting domain registration for: ${item.domainName}`
    );
    domainBookingStatus.push({
      step: "domain_registering",
      message: "Registering domain",
      timestamp: new Date(),
      progress: 80,
    });

    // M1 anti-corruption layer: rcRegisterDomain catches exceptions and
    // maps the raw RC response onto a typed RegisterDomainOutcome. The
    // callsite below switches on `outcome.kind` — no more
    // `result.message.toLowerCase().includes("insufficient balance")`
    // chains, no more split between the failed-branch + exception-branch
    // doing the same string heuristic twice.
    const outcome = await rcRegisterDomain({
      domainName: item.domainName,
      years: item.registrationPeriod || 1,
      customerId: customerResult.customerId,
      nameServers: registrationNameservers,
      contacts: {
        admin: customerResult.contactId,
        tech: customerResult.contactId,
        billing: customerResult.contactId,
      },
      tldAttributes: item.tldAttributes,
    });

    return dispatchOutcome(outcome, item, ctx, domainBookingStatus, user, orderId);
  } catch (error) {
    // rcRegisterDomain already maps exceptions to outcomes, so reaching
    // this catch means something in our own dispatchOutcome / Domain.create
    // threw. Treat as hard failure.
    serverLogger.error(
      `[PAYMENT-VERIFY] Unexpected post-registration error for ${item.domainName}:`,
      error
    );
    const message = error instanceof Error ? error.message : String(error);
    return dispatchOutcome(
      { kind: "hard_failure", reason: message },
      item,
      ctx,
      domainBookingStatus,
      user,
      orderId
    );
  }
}

/**
 * Translate the typed `RegisterDomainOutcome` into the existing branch
 * helpers. Keeps the per-branch logic (success vs pending vs failed) in
 * place — only the discrimination changes from string-matching to a
 * compile-time-checked union.
 */
async function dispatchOutcome(
  outcome: RegisterDomainOutcome,
  item: CartItem,
  ctx: DomainProvisionContext,
  domainBookingStatus: OrderDomain["bookingStatus"],
  user: IUser,
  orderId: string
): Promise<DomainProvisionResult> {
  switch (outcome.kind) {
    case "registered":
      return handleRegisteredDomain(item, ctx, outcome.orderId, domainBookingStatus, user, orderId);
    case "registered_no_order_id":
      return handleRegisteredNoOrderId(item, ctx, domainBookingStatus, user, orderId);
    case "balance_pending":
      return handleBalancePending(item, ctx, domainBookingStatus);
    case "already_in_progress":
      return handleAlreadyInProgress(item, ctx, domainBookingStatus);
    case "hard_failure":
      return handleHardFailure(item, ctx, outcome.reason, domainBookingStatus);
  }
}

/** Look up the RC order-id for a domain when the registerDomain response
 * didn't include it (or for the pending / already-in-progress branches
 * that don't get an orderId in the initial response). Best-effort —
 * returns undefined on failure. */
async function fetchOrderIdFallback(domainName: string): Promise<string | undefined> {
  try {
    const orderIdResponse = await ResellerClubWrapper.getDomainOrderId(domainName);
    if (orderIdResponse.status === "success" && orderIdResponse.data) {
      return String(orderIdResponse.data);
    }
    serverLogger.warn(
      `[PAYMENT-VERIFY] Order-id fallback returned no data for ${domainName}`
    );
  } catch (err) {
    serverLogger.warn(
      `[PAYMENT-VERIFY] Order-id fallback threw for ${domainName}:`,
      err
    );
  }
  return undefined;
}

/**
 * RC accepted the registration. If `rcOrderId` is undefined we do the
 * fallback fetch (the "registered_no_order_id" branch). On either path
 * we write a Domain record and return the success shape.
 */
async function handleRegisteredDomain(
  item: CartItem,
  ctx: DomainProvisionContext,
  rcOrderId: string | undefined,
  domainBookingStatus: OrderDomain["bookingStatus"],
  user: IUser,
  orderId: string
): Promise<DomainProvisionResult> {
  serverLogger.info(
    `✅ [PAYMENT-VERIFY] Domain registration successful: ${item.domainName}`
  );

  domainBookingStatus.push({
    step: "domain_registered",
    message: "Domain registered successfully",
    timestamp: new Date(),
    progress: 100,
  });

  const expiresAt = calculateItemExpiration(item).expiresAt;

  let resellerClubOrderId = rcOrderId;
  if (!resellerClubOrderId) {
    serverLogger.error(
      `⚠️ [PAYMENT-VERIFY] Domain registered but no orderid in response for ${item.domainName} — fetching fallback`
    );
    resellerClubOrderId = await fetchOrderIdFallback(item.domainName);
  }

  try {
    await Domain.create({
      userId: user._id,
      domainName: item.domainName,
      status: "pending",
      price: item.price,
      currency: item.currency || "INR",
      registrationPeriod: item.registrationPeriod || 1,
      orderId,
      resellerClubOrderId,
      dnsProvider: "resellerclub",
      registeredAt: new Date(),
      expiresAt,
      autoRenew: false,
      next_action_at: expiresAt
        ? new Date(expiresAt.getTime() - FIRST_REMINDER_DAYS * 24 * 60 * 60 * 1000)
        : undefined,
      last_reminder_sent: null,
    });
    serverLogger.info(
      `✅ [PAYMENT-VERIFY] Domain record created for ${item.domainName}`
    );
  } catch (dError) {
    serverLogger.error(
      `❌ [PAYMENT-VERIFY] Failed to create Domain record:`,
      dError
    );
  }

  return {
    successfulDomain: item.domainName,
    registrationResult: {
      domainName: item.domainName,
      status: "success",
      orderId: resellerClubOrderId,
      itemType: "domain",
    },
    orderDomain: {
      domainName: item.domainName,
      itemType: "domain",
      price: item.price,
      currency: item.currency || "INR",
      registrationPeriod: item.registrationPeriod || 1,
      periodUnit: item.periodUnit || "years",
      status: "pending",
      dnsProvider: "resellerclub",
      bookingStatus: domainBookingStatus,
      orderId: resellerClubOrderId,
      expiresAt,
      resellerClubOrderId,
      resellerClubCustomerId: ctx.customerResult.customerId,
      resellerClubContactId: ctx.customerResult.contactId,
    },
  };
}

/** Wrapper for the `registered_no_order_id` outcome — delegate to the
 * regular registered handler with undefined orderId; the fallback fetch
 * kicks in there. */
function handleRegisteredNoOrderId(
  item: CartItem,
  ctx: DomainProvisionContext,
  domainBookingStatus: OrderDomain["bookingStatus"],
  user: IUser,
  orderId: string
): Promise<DomainProvisionResult> {
  return handleRegisteredDomain(item, ctx, undefined, domainBookingStatus, user, orderId);
}

/**
 * Build the pending-orderDomain shape used by both balance-pending and
 * already-in-progress branches. Returned status is "pending" in both
 * cases; only the user-facing copy differs.
 */
async function buildPendingOrderDomain(
  item: CartItem,
  ctx: DomainProvisionContext,
  domainBookingStatus: OrderDomain["bookingStatus"],
  userFacingError: string
): Promise<DomainProvisionResult> {
  const pendingRcOrderId = await fetchOrderIdFallback(item.domainName);

  return {
    registrationResult: {
      domainName: item.domainName,
      status: "pending",
      error: userFacingError,
      orderId: pendingRcOrderId,
      itemType: "domain",
    },
    orderDomain: {
      domainName: item.domainName,
      itemType: "domain",
      price: item.price,
      currency: item.currency || "INR",
      registrationPeriod: item.registrationPeriod || 1,
      periodUnit: item.periodUnit || "years",
      status: "pending",
      dnsProvider: "resellerclub",
      bookingStatus: domainBookingStatus,
      error: userFacingError,
      resellerClubOrderId: pendingRcOrderId,
      resellerClubCustomerId: ctx.customerResult.customerId,
      resellerClubContactId: ctx.customerResult.contactId,
    },
  };
}

/** RC put the registration in balance-pending state. Auto-resolves when
 * ops tops up the reseller account; we treat it as pending and let the
 * self-heal cron flip it to registered later. */
function handleBalancePending(
  item: CartItem,
  ctx: DomainProvisionContext,
  domainBookingStatus: OrderDomain["bookingStatus"]
): Promise<DomainProvisionResult> {
  serverLogger.info(
    `⏳ [PAYMENT-VERIFY] Domain registration balance-pending: ${item.domainName}`
  );
  return buildPendingOrderDomain(
    item,
    ctx,
    domainBookingStatus,
    "Domain registration pending due to insufficient balance"
  );
}

/** RC says the same name is already in flight (duplicate or pre-existing
 * pending order on our reseller side). Treat as pending — the prior order
 * will complete and we'll surface that completion via the cron. */
function handleAlreadyInProgress(
  item: CartItem,
  ctx: DomainProvisionContext,
  domainBookingStatus: OrderDomain["bookingStatus"]
): Promise<DomainProvisionResult> {
  serverLogger.info(
    `⏳ [PAYMENT-VERIFY] Domain registration already in progress: ${item.domainName}`
  );
  return buildPendingOrderDomain(
    item,
    ctx,
    domainBookingStatus,
    "Domain registration is being processed."
  );
}

/** Truly failed — TLD validation, locked domain, contact-data rejection,
 * etc. `reason` is internal-only (already logged inside the integration
 * layer); the user sees the generic message. */
function handleHardFailure(
  item: CartItem,
  ctx: DomainProvisionContext,
  _reason: string,
  domainBookingStatus: OrderDomain["bookingStatus"]
): DomainProvisionResult {
  const userFacingError =
    "Domain registration failed. Our team has been notified — please contact support if this persists.";
  const statusMessage = "Domain registration failed. Our team has been notified.";

  domainBookingStatus.push({
    step: "domain_failed",
    message: statusMessage,
    timestamp: new Date(),
    progress: 100,
  });

  return {
    registrationResult: {
      domainName: item.domainName,
      status: "failed",
      itemType: "domain",
      error: userFacingError,
    },
    orderDomain: {
      domainName: item.domainName,
      itemType: "domain",
      price: item.price,
      currency: item.currency || "INR",
      registrationPeriod: item.registrationPeriod || 1,
      periodUnit: item.periodUnit || "years",
      status: "failed",
      dnsProvider: "resellerclub",
      bookingStatus: domainBookingStatus,
      error: userFacingError,
      resellerClubCustomerId: ctx.customerResult.customerId,
      resellerClubContactId: ctx.customerResult.contactId,
    },
  };
}
