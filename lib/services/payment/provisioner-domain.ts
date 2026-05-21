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

import type { IUser } from "@/models/User";
import type { CartItem, ResellerClubResponse } from "@/lib/types";
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

    const result = await ResellerClubWrapper.registerDomain(
      item.domainName,
      item.registrationPeriod || 1,
      customerResult.customerId,
      registrationNameservers,
      {
        admin: customerResult.contactId,
        tech: customerResult.contactId,
        billing: customerResult.contactId,
      },
      item.tldAttributes
    );

    if (result.status === "success") {
      return handleSuccessfulDomain(item, ctx, result, domainBookingStatus, user, orderId);
    } else if (result.status === "pending") {
      return handlePendingDomain(item, ctx, result, domainBookingStatus);
    } else {
      return handleFailedDomain(item, ctx, result, domainBookingStatus);
    }
  } catch (error) {
    return handleDomainException(error, item, ctx, domainBookingStatus);
  }
}

/** ResellerClub returned status=success — write the Domain record, build
 * the success shape. */
async function handleSuccessfulDomain(
  item: CartItem,
  ctx: DomainProvisionContext,
  result: ResellerClubResponse,
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

  let resellerClubOrderId = result.data?.orderid;

  if (!resellerClubOrderId) {
    serverLogger.error(
      `⚠️ [PAYMENT-VERIFY] WARNING: Domain registered but no orderid in response for ${item.domainName}! Attempting fallback fetch...`
    );
    try {
      const orderIdResponse = await ResellerClubWrapper.getDomainOrderId(
        item.domainName
      );
      if (orderIdResponse.status === "success" && orderIdResponse.data) {
        resellerClubOrderId = orderIdResponse.data;
        serverLogger.info(
          `✅ [PAYMENT-VERIFY] Fallback success! Retrieved Order ID: ${resellerClubOrderId} for ${item.domainName}`
        );
      } else {
        serverLogger.error(
          `❌ [PAYMENT-VERIFY] Fallback failed: Could not retrieve Order ID even after search. Response:`,
          orderIdResponse
        );
      }
    } catch (fallbackError) {
      serverLogger.error(
        `❌ [PAYMENT-VERIFY] Fallback error: Exception while fetching Order ID for ${item.domainName}:`,
        fallbackError
      );
    }
  }

  try {
    await Domain.create({
      userId: user._id,
      domainName: item.domainName,
      status: "pending",
      price: item.price,
      currency: item.currency || "INR",
      registrationPeriod: item.registrationPeriod || 1,
      orderId: orderId,
      resellerClubOrderId: resellerClubOrderId,
      dnsProvider: "resellerclub",
      registeredAt: new Date(),
      expiresAt: expiresAt,
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
      resellerClubOrderId: resellerClubOrderId,
      resellerClubCustomerId: ctx.customerResult.customerId,
      resellerClubContactId: ctx.customerResult.contactId,
    },
  };
}

/** ResellerClub returned status=pending — typical when insufficient balance
 * pushes the order to manual review. */
async function handlePendingDomain(
  item: CartItem,
  ctx: DomainProvisionContext,
  result: ResellerClubResponse,
  domainBookingStatus: OrderDomain["bookingStatus"]
): Promise<DomainProvisionResult> {
  serverLogger.info(
    `⏳ [PAYMENT-VERIFY] Domain registration pending: ${item.domainName} - ${result.message}`
  );

  let pendingRcOrderId = result.data?.orderid;
  if (!pendingRcOrderId) {
    try {
      const orderIdResponse = await ResellerClubWrapper.getDomainOrderId(item.domainName);
      if (orderIdResponse.status === "success" && orderIdResponse.data) {
        pendingRcOrderId = orderIdResponse.data;
      }
    } catch {
      serverLogger.warn(
        `[PAYMENT-VERIFY] Failed to fetch Order ID for pending domain ${item.domainName}`
      );
    }
  }

  return {
    registrationResult: {
      domainName: item.domainName,
      status: "pending",
      error: result.message,
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
      error: result.message,
      resellerClubOrderId: pendingRcOrderId,
      resellerClubCustomerId: ctx.customerResult.customerId,
      resellerClubContactId: ctx.customerResult.contactId,
    },
  };
}

/** ResellerClub returned anything other than success/pending. Some "failed"
 * messages are actually retryable (insufficient-balance variants) so we
 * down-grade them to status=pending. */
async function handleFailedDomain(
  item: CartItem,
  ctx: DomainProvisionContext,
  result: ResellerClubResponse,
  domainBookingStatus: OrderDomain["bookingStatus"]
): Promise<DomainProvisionResult> {
  serverLogger.error(
    `❌ [PAYMENT-VERIFY] Domain registration failed: ${item.domainName} - ${result.message}`
  );

  serverLogger.info(
    `🔍 [PAYMENT-VERIFY] ResellerClub response for "${item.domainName}":`,
    { status: result.status, message: result.message, data: result.data }
  );

  const isInsufficientBalance =
    result.status === "pending" ||
    (result.message &&
      (result.message.toLowerCase().includes("insufficient balance") ||
        result.message.toLowerCase().includes("low funds") ||
        result.message.toLowerCase().includes("insufficient funds") ||
        result.message.toLowerCase().includes("account balance") ||
        result.message.toLowerCase().includes("credit limit") ||
        result.message.toLowerCase().includes("already exists in our database") ||
        result.message.toLowerCase().includes("pending order") ||
        result.message.toLowerCase().includes("pending order for")));

  const domainStatus = isInsufficientBalance ? "pending" : "failed";
  const statusMessage = isInsufficientBalance
    ? result.message?.toLowerCase().includes("already exists in our database")
      ? "Domain registration is being processed."
      : "Domain registration pending due to insufficient balance"
    : `Domain registration failed: ${result.message || "Unknown error"}`;

  let failedRcOrderId = result.data?.orderid;
  if (!failedRcOrderId && isInsufficientBalance) {
    try {
      const orderIdResponse = await ResellerClubWrapper.getDomainOrderId(item.domainName);
      if (orderIdResponse.status === "success" && orderIdResponse.data) {
        failedRcOrderId = orderIdResponse.data;
      }
    } catch {
      serverLogger.warn(
        `[PAYMENT-VERIFY] Failed to fetch Order ID for on-hold domain ${item.domainName}`
      );
    }
  }

  if (!isInsufficientBalance) {
    domainBookingStatus.push({
      step: "domain_failed",
      message: statusMessage,
      timestamp: new Date(),
      progress: 100,
    });
  }

  return {
    registrationResult: {
      domainName: item.domainName,
      status: domainStatus,
      itemType: "domain",
      orderId: failedRcOrderId,
      error: result.message,
    },
    orderDomain: {
      domainName: item.domainName,
      itemType: "domain",
      price: item.price,
      currency: item.currency || "INR",
      registrationPeriod: item.registrationPeriod || 1,
      periodUnit: item.periodUnit || "years",
      status: domainStatus,
      dnsProvider: "resellerclub",
      bookingStatus: domainBookingStatus,
      error: result.message,
      resellerClubOrderId: failedRcOrderId,
      resellerClubCustomerId: ctx.customerResult.customerId,
      resellerClubContactId: ctx.customerResult.contactId,
    },
  };
}

/** Exception path — same insufficient-balance heuristic as the failed
 * branch, but operating on an exception message instead of a result shape. */
function handleDomainException(
  error: unknown,
  item: CartItem,
  ctx: DomainProvisionContext,
  domainBookingStatus: OrderDomain["bookingStatus"]
): DomainProvisionResult {
  serverLogger.error(
    `Domain registration error for ${item.domainName}:`,
    error
  );

  const errorMessage = error instanceof Error ? error.message : "Unknown error";

  serverLogger.info(
    `🔍 [PAYMENT-VERIFY] Domain registration error for "${item.domainName}":`,
    {
      error: errorMessage,
      errorType:
        error instanceof Error ? error.constructor.name : typeof error,
      stack: error instanceof Error ? error.stack : undefined,
    }
  );

  const isInsufficientBalance =
    errorMessage &&
    (errorMessage.toLowerCase().includes("insufficient balance") ||
      errorMessage.toLowerCase().includes("low funds") ||
      errorMessage.toLowerCase().includes("insufficient funds") ||
      errorMessage.toLowerCase().includes("account balance") ||
      errorMessage.toLowerCase().includes("credit limit"));

  const domainStatus = isInsufficientBalance ? "pending" : "failed";
  const statusMessage = isInsufficientBalance
    ? "Domain registration pending due to insufficient balance"
    : `Registration failed: ${errorMessage}`;

  domainBookingStatus.push({
    step: isInsufficientBalance ? "domain_pending" : "domain_failed",
    message: statusMessage,
    timestamp: new Date(),
    progress: isInsufficientBalance ? 50 : 100,
  });

  return {
    registrationResult: {
      domainName: item.domainName,
      status: domainStatus,
      itemType: "domain",
      error: errorMessage,
    },
    orderDomain: {
      domainName: item.domainName,
      itemType: "domain",
      price: item.price,
      currency: item.currency || "INR",
      registrationPeriod: item.registrationPeriod || 1,
      periodUnit:
        item.periodUnit || (item.itemType === "hosting" ? "months" : "years"),
      status: domainStatus,
      dnsProvider: "resellerclub",
      bookingStatus: domainBookingStatus,
      error: errorMessage,
      resellerClubCustomerId: ctx.customerResult.customerId,
      resellerClubContactId: ctx.customerResult.contactId,
    },
  };
}
