/**
 * Cart-provisioning orchestrator (post-payment).
 *
 * Walks every cart item, dispatches hosting items to `provisionHostingItem`
 * and domain items to `provisionDomainItem`, then runs the post-loop
 * verification phase that turns silently-failed registrations into
 * PendingDomain audit rows.
 *
 * This file was 1054 lines before the H2 decomposition (commit history).
 * The per-item branches now live in their own modules; this orchestrator
 * is intentionally thin so the dispatch logic stays readable.
 */
import { ResellerClubAPI } from "@/lib/resellerclub";
import { serverLogger } from "@/lib/server-logger";
import connectDB from "@/lib/mongodb";
import { setUserResellerClubIds } from "@/lib/services/users";
import { isHostingItem } from "@/lib/billing";

import type { IUser } from "@/models/User";
import type { CartItem } from "@/lib/types";

import { provisionHostingItem } from "./provisioner-hosting";
import { provisionDomainItem } from "./provisioner-domain";
import { runDomainVerificationPhase } from "./provisioner-verification";

/** One entry in the per-item registration result array. */
export interface RegistrationResult {
  domainName: string;
  status: "success" | "pending" | "failed" | "already_registered";
  itemType: "domain" | "hosting";
  orderId?: string;
  message?: string;
  error?: string;
  expiresAt?: string;
  validity?: string;
}

/** One entry in the orderDomains / finalSuccessfulDomains array written to the Order document. */
export interface OrderDomain {
  domainName: string;
  itemType: "domain" | "hosting";
  price: number;
  currency: string;
  registrationPeriod: number;
  periodUnit?: string;
  status: string;
  dnsProvider: "resellerclub" | "directadmin";
  bookingStatus: { step: string; message: string; timestamp: Date; progress: number }[];
  orderId?: string;
  resellerClubCustomerId?: number;
  resellerClubOrderId?: string;
  resellerClubContactId?: number;
  registeredAt?: Date;
  expiresAt?: Date;
  planName?: string;
  hostingPlan?: Record<string, unknown>;
  error?: string;
}

export interface ProvisionerContext {
  cartItems: CartItem[];
  user: IUser;
  orderId: string;
  razorpay_payment_id: string;
  razorpay_subscription_id?: string;
}

export interface ProvisionerResult {
  registrationResults: RegistrationResult[];
  successfulDomains: string[];
  orderDomains: OrderDomain[];
  finalSuccessfulDomains: string[];
  pendingDomains: OrderDomain[];
  failedDomains: OrderDomain[];
}

export async function provisionCartItems(
  ctx: ProvisionerContext
): Promise<ProvisionerResult> {
  const { cartItems, user, orderId, razorpay_payment_id, razorpay_subscription_id } = ctx;

  await connectDB();

  const customerResult = await setupRcCustomerAndContact(user);

  // Per-item helpers are pure-returning (see H2 decomposition): each yields
  // {registrationResult, orderDomain, successfulDomain?}. Fan out with
  // Promise.all so a 5-item cart doesn't pay 5× the RC + DA latency. Output
  // order is preserved by `cartItems.map` — same as the prior for-loop.
  //
  // The hosting branch mutates `user.directAdminUsername` via
  // setUserDirectAdminUsername — guarded with a CAS-style "only set when
  // empty" filter, so two concurrent hosting items race-safe: the first
  // writer wins on the User row, the second is a no-op (the second
  // Hosting doc still carries its own correct DA username).
  const perItem = await Promise.all(
    cartItems.map(async (item) => {
      if (isHostingItem(item)) {
        return provisionHostingItem(item, {
          user,
          orderId,
          razorpay_payment_id,
          razorpay_subscription_id,
          customerResult,
        });
      }

      // Placeholder hosting domain names — the hosting item already covered
      // this cart slot; emit a success row so the response shape stays stable.
      if (item.domainName.startsWith("hosting-")) {
        serverLogger.warn(
          `⚠️ [PAYMENT-VERIFY] Skipping domain registration for placeholder: ${item.domainName}`
        );
        return {
          registrationResult: {
            domainName: item.domainName,
            status: "success" as const,
            message: "Hosting setup complete",
            itemType: "hosting" as const,
          },
          // Placeholder rows don't contribute an orderDomain — they ride on
          // the linked hosting item's row instead.
          orderDomain: null,
        };
      }

      return provisionDomainItem(item, {
        user,
        orderId,
        cartItems,
        customerResult,
      });
    })
  );

  const registrationResults: RegistrationResult[] = [];
  const successfulDomains: string[] = [];
  const orderDomains: OrderDomain[] = [];
  for (const r of perItem) {
    registrationResults.push(r.registrationResult);
    if (r.orderDomain) orderDomains.push(r.orderDomain);
    if ("successfulDomain" in r && r.successfulDomain) {
      successfulDomains.push(r.successfulDomain);
    }
  }

  serverLogger.info("📊 [PAYMENT-VERIFY] Domain registration summary:", {
    totalDomains: cartItems.length,
    successful: successfulDomains.length,
    successfulDomains,
  });

  await runDomainVerificationPhase(orderDomains, {
    user,
    orderId,
    customerResult,
  });

  const finalSuccessfulDomains = orderDomains
    .filter((d) => d.status === "registered" && d.itemType !== "hosting")
    .map((d) => d.domainName);

  serverLogger.info(
    "📊 [PAYMENT-VERIFY] Final success summary after verification:",
    {
      total: orderDomains.length,
      successfulCount: finalSuccessfulDomains.length,
      successfulDomains: finalSuccessfulDomains,
    }
  );

  if (finalSuccessfulDomains.length !== successfulDomains.length) {
    serverLogger.info(
      `⚠️ [PAYMENT-VERIFY] Success count changed from ${successfulDomains.length} to ${finalSuccessfulDomains.length} after verification`
    );
  }

  const pendingDomains = orderDomains.filter((d) => d.status === "pending");
  const failedDomains = orderDomains.filter((d) => d.status === "failed");

  return {
    registrationResults,
    successfulDomains,
    orderDomains,
    finalSuccessfulDomains,
    pendingDomains,
    failedDomains,
  };
}

/**
 * Get or create the ResellerClub customer + contact pair for this user,
 * persisting any newly-generated IDs back on the User document so future
 * profile edits can sync via `modifyContact()`.
 */
async function setupRcCustomerAndContact(user: IUser): Promise<{
  customerId: number;
  contactId: number;
}> {
  serverLogger.info(
    `👤 [PAYMENT-VERIFY] Creating/verifying customer account for: ${user.email}`
  );

  const customerResult = await ResellerClubAPI.getOrCreateCustomerAndContact({
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    phoneCc: user.phoneCc,
    companyName: user.companyName,
    address: user.address
      ? {
          line1: user.address.line1,
          city: user.address.city,
          state: user.address.state,
          country: user.address.country,
          zipcode: user.address.zipcode,
        }
      : undefined,
  });

  if (
    customerResult.status !== "success" ||
    !customerResult.customerId ||
    !customerResult.contactId
  ) {
    serverLogger.error(
      `❌ [PAYMENT-VERIFY] Failed to get ResellerClub customer/contact IDs for user ${user.email}:`,
      customerResult.error
    );
    throw new Error("Failed to get ResellerClub customer/contact IDs");
  }

  // Persist RC IDs on the User so future profile updates can sync the contact
  // record via modifyContact(). getOrCreateCustomerAndContact() is a no-op DB
  // writer; we own persistence here. Only fields the user doesn't already
  // have get written — single round-trip, then mirror onto the in-memory
  // `user` so callers later in the request don't refetch.
  try {
    await setUserResellerClubIds(String(user._id), {
      customerId: user.resellerClubCustomerId ? undefined : customerResult.customerId,
      contactId: user.resellerClubContactId ? undefined : customerResult.contactId,
    });
    if (!user.resellerClubCustomerId) {
      user.resellerClubCustomerId = customerResult.customerId;
    }
    if (!user.resellerClubContactId) {
      user.resellerClubContactId = customerResult.contactId;
    }
  } catch (persistErr) {
    serverLogger.error("[PAYMENT-VERIFY] Failed to persist RC IDs on user:", persistErr);
  }

  serverLogger.info(
    `✅ [PAYMENT-VERIFY] Customer account created successfully: ${customerResult.customerId}`
  );

  return {
    customerId: customerResult.customerId,
    contactId: customerResult.contactId,
  };
}
