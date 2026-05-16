import { DirectAdminService, DirectAdminError } from "@/lib/directadmin";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { ResellerClubAPI } from "@/lib/resellerclub";
import { EmailService } from "@/lib/email";
import { DomainVerificationService } from "@/lib/domain-verification";
import { serverLogger } from "@/lib/server-logger";
import connectDB from "@/lib/mongodb";
import User from "@/models/User";
import { getPlanByPlanId } from "@/lib/services/hosting-plans";
import Hosting from "@/models/Hosting";
import Domain from "@/models/Domain";
import PendingDomain from "@/models/PendingDomain";
import { isHostingItem, calculateItemExpiration } from "@/lib/billing";
import { calculateHostingDates } from "@/lib/hosting-dates";
import { HOSTING_PLANS } from "@/config/hosting-plans";
import { AUTOMATION_CONFIG } from "@/config/automation";
import crypto from "crypto";

// Days before expiry when the first reminder check should be scheduled
const FIRST_REMINDER_DAYS = Math.max(...AUTOMATION_CONFIG.REMINDER_DAYS);

// Price → DirectAdmin package name lookup, derived from the canonical HOSTING_PLANS config.
// Avoids duplicating prices as magic numbers here and in config/hosting-plans.ts.
const PRICE_TO_PACKAGE: Record<number, string> = Object.values(HOSTING_PLANS).reduce(
  (acc, plan) => {
    acc[plan.price] = plan.serverPackage;
    return acc;
  },
  {} as Record<number, string>
);

function generateDaUsername(domainPrefix: string): string {
  const prefix = domainPrefix.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 5) || "user";
  const suffix = crypto.randomBytes(4).toString("hex").slice(0, 5);
  return `${prefix}${suffix}`;
}

import type { IUser } from "@/models/User";
import type { CartItem } from "@/lib/types";

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

  const registrationResults: RegistrationResult[] = [];
  const successfulDomains: string[] = [];
  const orderDomains: OrderDomain[] = [];
  let nameServers: string[] | undefined;

  // Get or create ResellerClub customer + contact IDs once (not per item)
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
  // writer; we own persistence here.
  try {
    const UserModel = (await import("@/models/User")).default;
    const updates: Record<string, number> = {};
    if (!user.resellerClubCustomerId) updates.resellerClubCustomerId = customerResult.customerId;
    if (!user.resellerClubContactId) updates.resellerClubContactId = customerResult.contactId;
    if (Object.keys(updates).length > 0) {
      await UserModel.updateOne({ _id: user._id }, { $set: updates });
    }
  } catch (persistErr) {
    // Non-fatal — provisioning continues. We just lose the ability to auto-sync later.
    serverLogger.error("[PAYMENT-VERIFY] Failed to persist RC IDs on user:", persistErr);
  }

  serverLogger.info(
    `✅ [PAYMENT-VERIFY] Customer account created successfully: ${customerResult.customerId}`
  );

  if (!user.resellerClubCustomerId) {
    try {
      await User.updateOne(
        { _id: user._id },
        { $set: { resellerClubCustomerId: customerResult.customerId } }
      );
      user.resellerClubCustomerId = customerResult.customerId;
      serverLogger.info(
        `✅ [PAYMENT-VERIFY] Saved ResellerClub customer ID to database: ${user.email}`
      );
    } catch (error) {
      serverLogger.error(
        `⚠️ [PAYMENT-VERIFY] Failed to save ResellerClub customer ID:`,
        error
      );
    }
  }

  for (const item of cartItems) {
    const isHosting = isHostingItem(item);

    if (isHosting) {
      const targetDomain = item.linkedDomain || item.domainName;
      serverLogger.info(
        `🔄 [PAYMENT-VERIFY] Verified. Provisioning hosting for: ${targetDomain}`
      );

      let packageName = item.hostingPlan?.serverPackage;

      if (!packageName) {
        const planName = (item.hostingPlan?.name || "").toLowerCase();
        if (planName.includes("starter")) packageName = "Starter";
        else if (planName.includes("standard")) packageName = "Standard";
        else if (planName.includes("plus")) packageName = "Plus";

        if (packageName) {
          serverLogger.info(
            `📦 [PAYMENT-VERIFY] Inferred package from name: ${planName} -> ${packageName}`
          );
        }
      }

      if (!packageName) {
        const price = item.price;
        packageName = PRICE_TO_PACKAGE[price];

        if (packageName) {
          serverLogger.info(
            `📦 [PAYMENT-VERIFY] Inferred package from price: ₹${price} -> ${packageName}`
          );
        }
      }

      if (!packageName) {
        packageName = process.env.DA_DEFAULT_PACKAGE || "Starter";
        serverLogger.warn(`⚠️ [PAYMENT-VERIFY] Using fallback package: ${packageName}`);
      }

      const daIp = process.env.DIRECTADMIN_IP || "136.115.64.54";

      // Retry up to 3 times on username collision (cryptographically random suffix)
      const MAX_USERNAME_ATTEMPTS = 3;
      let daUsername = "";

      try {
        for (let attempt = 1; attempt <= MAX_USERNAME_ATTEMPTS; attempt++) {
          daUsername = generateDaUsername(targetDomain);
          serverLogger.info(`👤 [PAYMENT-VERIFY] Generated DA Username (attempt ${attempt}): ${daUsername}`);
          serverLogger.info(`📦 [PAYMENT-VERIFY] Creating DA User: ${daUsername} on package ${packageName} with IP ${daIp}`);
          try {
            await DirectAdminService.createUser(
              daUsername,
              user.email,
              targetDomain,
              packageName,
              daIp
            );
            break; // success — exit retry loop
          } catch (usernameErr: any) {
            const msg = (usernameErr.message || "").toLowerCase();
            if (attempt < MAX_USERNAME_ATTEMPTS && msg.includes("already exists")) {
              serverLogger.warn(`⚠️ [PAYMENT-VERIFY] Username collision on "${daUsername}", retrying (${attempt}/${MAX_USERNAME_ATTEMPTS})`);
              continue;
            }
            throw usernameErr; // non-collision error or final attempt — propagate
          }
        }

        let planName = packageName;
        try {
          const plan = await getPlanByPlanId(packageName);
          if (plan && plan.name) planName = plan.name;
        } catch (e) {
          serverLogger.warn("Failed to fetch hosting plan name for email", e);
        }

        await User.updateOne(
          { _id: user._id },
          { $set: { directAdminUsername: daUsername } }
        );
        user.directAdminUsername = daUsername;

        serverLogger.info(
          `✅ [PAYMENT-VERIFY] Saved DA username to database: ${daUsername}`
        );

        successfulDomains.push(targetDomain);

        try {
          await EmailService.sendHostingProvisionedEmail(
            user.email,
            user.firstName || "User",
            {
              domainName: targetDomain,
              packageName: packageName,
              planName: planName,
              serverIp: daIp,
              nameservers: DirectAdminService.NAMESERVERS,
            }
          );
          serverLogger.info(
            `✉️ [PAYMENT-VERIFY] Hosting provision email sent to ${user.email}`
          );
        } catch (emailError: any) {
          serverLogger.error(
            `⚠️ [PAYMENT-VERIFY] Failed to send hosting provision email: ${emailError.message}`
          );
        }

        const isTrial = item.isTrial === true;

        // For trial items: always 15-day expiry regardless of registrationPeriod
        const safeUnit: "months" | "days" | "minutes" = isTrial
          ? "days"
          : item.periodUnit === "years" || !item.periodUnit
          ? "months"
          : item.periodUnit;
        const safePeriod = isTrial ? 15 : (item.registrationPeriod || 1);

        const { registeredAt, expiresAt } = calculateHostingDates(safePeriod, safeUnit);

        try {
          await Hosting.create({
            userId: user._id,
            domainName: targetDomain,
            planId: packageName,
            name: planName || "Hosting Plan",
            serverPackage: packageName,
            status: "active",
            startDate: registeredAt,
            expiryDate: expiresAt,
            directAdminUsername: daUsername,
            orderId: orderId,
            paymentId: razorpay_payment_id,
            subscriptionId: razorpay_subscription_id || undefined,
            autoRenew: !!razorpay_subscription_id,
            billingType: razorpay_subscription_id ? "subscription" : "manual",
            isTrial,
            next_action_at: new Date(
              expiresAt.getTime() - FIRST_REMINDER_DAYS * 24 * 60 * 60 * 1000
            ),
            last_reminder_sent: null,
          });
          serverLogger.info(
            `✅ [PAYMENT-VERIFY] Hosting record created for ${targetDomain} (Subscription: ${
              razorpay_subscription_id || "None"
            })`
          );
        } catch (hError) {
          serverLogger.error(
            `❌ [PAYMENT-VERIFY] Failed to create Hosting record:`,
            hError
          );
        }

        const validityUnit =
          safeUnit === "days"
            ? "Day"
            : safeUnit === "minutes"
            ? "Minute"
            : "Month";
        registrationResults.push({
          domainName: targetDomain,
          status: "success",
          message: isTrial ? "Hosting trial provisioned (15 days free)" : "Hosting account provisioned",
          itemType: "hosting",
          expiresAt: expiresAt.toISOString(),
          validity: `${safePeriod} ${validityUnit}${safePeriod !== 1 ? "s" : ""}`,
        });

        orderDomains.push({
          domainName: item.domainName,
          price: item.price,
          currency: item.currency || "INR",
          registrationPeriod: safePeriod,
          status: "registered",
          itemType: "hosting",
          dnsProvider: "directadmin",
          periodUnit: safeUnit,
          hostingPlan: {
            ...item.hostingPlan,
            name: planName || item.hostingPlan?.name,
          },
          planName: planName,
          bookingStatus: [
            {
              step: "payment_verified",
              message: "Payment verified successfully",
              timestamp: new Date(),
              progress: 100,
            },
            {
              step: "domain_registered",
              message: "Hosting account active",
              timestamp: new Date(),
              progress: 100,
            },
          ],
          resellerClubCustomerId: customerResult.customerId,
          registeredAt: registeredAt,
          expiresAt: expiresAt,
        });
      } catch (error: any) {
        let context = "Hosting Provisioning";
        let details = error.message;

        if (error instanceof DirectAdminError) {
          context = `DA-FAIL: ${error.context || "Unknown Operation"}`;
          details = `${error.message} (Status: ${error.status})`;
          serverLogger.error(`[${context}] ${details}`, {
            response: error.response,
          });
        } else {
          serverLogger.error(
            `[PAYMENT-VERIFY-HOSTING] Unexpected error: ${error.message}`,
            error
          );
        }

        serverLogger.error(
          `❌ [PAYMENT-VERIFY] Hosting provisioning failed: ${details}`
        );

        try {
          const { createPendingHosting } = await import(
            "@/lib/services/pending-hostings"
          );
          await createPendingHosting({
            userId: user._id,
            domain: targetDomain,
            package: packageName,
            daUsername: daUsername,
            error: details,
            status: "failed",
          });
          serverLogger.info(
            `📝 [PAYMENT-VERIFY] Created PendingHosting record for failed provision: ${targetDomain}`
          );
        } catch (phError) {
          serverLogger.error(
            `❌ [PAYMENT-VERIFY] Failed to create PendingHosting record:`,
            phError
          );
        }

        registrationResults.push({
          domainName: targetDomain,
          status: "failed",
          error: details,
          itemType: "hosting",
        });

        orderDomains.push({
          domainName: item.domainName,
          price: item.price,
          currency: item.currency || "INR",
          registrationPeriod: item.registrationPeriod || 1,
          periodUnit: item.periodUnit || "months",
          status: "failed",
          itemType: "hosting",
          dnsProvider: "directadmin",
          hostingPlan: item.hostingPlan,
          bookingStatus: [
            {
              step: "domain_failed",
              message: `Provisioning failed: ${details}`,
              timestamp: new Date(),
              progress: 100,
            },
          ],
          error: details,
        });
      }

      continue;
    }

    // Skip placeholder hosting domain names
    if (item.domainName.startsWith("hosting-")) {
      serverLogger.warn(
        `⚠️ [PAYMENT-VERIFY] Skipping domain registration for placeholder: ${item.domainName}`
      );
      registrationResults.push({
        domainName: item.domainName,
        status: "success",
        message: "Hosting setup complete",
        itemType: "hosting",
      });
      continue;
    }

    // Guard: skip registration if an active Domain record already exists for this name.
    // This prevents re-registering a domain that was soft-deleted and then re-purchased.
    const existingActiveDomain = await Domain.findOne({
      domainName: item.domainName,
      deletedAt: null,
    }).lean();
    if (existingActiveDomain) {
      serverLogger.warn(`⚠️ [PAYMENT-VERIFY] Active domain record already exists for ${item.domainName}, skipping ResellerClub registration`);
      registrationResults.push({ domainName: item.domainName, status: "already_registered", itemType: "domain" });
      successfulDomains.push(item.domainName);
      orderDomains.push({
        domainName: item.domainName,
        itemType: "domain",
        price: item.price,
        currency: item.currency || "INR",
        registrationPeriod: item.registrationPeriod || 1,
        periodUnit: item.periodUnit || "years",
        status: "registered",
        dnsProvider: "resellerclub",
        bookingStatus: [{ step: "domain_registered", message: "Domain already active", timestamp: new Date(), progress: 100 }],
      });
      continue;
    }

    serverLogger.info(`🔄 [PAYMENT-VERIFY] Registering domain: ${item.domainName}`);

    const domainBookingStatus: OrderDomain["bookingStatus"] = [
      {
        step: "payment_verified",
        message: "Payment verified successfully",
        timestamp: new Date(),
        progress: 20,
      },
      {
        step: "customer_created",
        message: "Setting up your account",
        timestamp: new Date(),
        progress: 40,
      },
      {
        step: "contact_created",
        message: "Account setup completed",
        timestamp: new Date(),
        progress: 60,
      },
    ];

    try {
      const isHostedInThisOrder = cartItems.some(
        (cartItem) =>
          cartItem.itemType === "hosting" &&
          (cartItem.linkedDomain === item.domainName ||
            cartItem.domainName === item.domainName)
      );

      if (isHostedInThisOrder) {
        serverLogger.info(
          `🌐 [PAYMENT-VERIFY] Domain ${item.domainName} is paired with Hosting. Using ResellerClub Default Nameservers per new policy.`
        );
      } else {
        serverLogger.info(
          `🌐 [PAYMENT-VERIFY] Domain ${item.domainName} is Domain Only. Using ResellerClub Default Nameservers.`
        );
      }

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
            if (
              orderIdResponse.status === "success" &&
              orderIdResponse.data
            ) {
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

        successfulDomains.push(item.domainName);

        registrationResults.push({
          domainName: item.domainName,
          status: "success",
          orderId: resellerClubOrderId,
          itemType: "domain",
        });

        orderDomains.push({
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
          resellerClubCustomerId: customerResult.customerId,
          resellerClubContactId: customerResult.contactId,
        });
      } else if (result.status === "pending") {
        serverLogger.info(
          `⏳ [PAYMENT-VERIFY] Domain registration pending: ${item.domainName} - ${result.message}`
        );

        let pendingRcOrderId = result.data?.orderid;
        if (!pendingRcOrderId) {
          try {
            const orderIdResponse =
              await ResellerClubWrapper.getDomainOrderId(item.domainName);
            if (
              orderIdResponse.status === "success" &&
              orderIdResponse.data
            ) {
              pendingRcOrderId = orderIdResponse.data;
            }
          } catch (e) {
            serverLogger.warn(
              `[PAYMENT-VERIFY] Failed to fetch Order ID for pending domain ${item.domainName}`
            );
          }
        }

        registrationResults.push({
          domainName: item.domainName,
          status: "pending",
          error: result.message,
          orderId: pendingRcOrderId,
          itemType: "domain",
        });

        orderDomains.push({
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
          resellerClubCustomerId: customerResult.customerId,
          resellerClubContactId: customerResult.contactId,
        });
      } else {
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
            (result.message?.toLowerCase().includes("insufficient balance") ||
              result.message?.toLowerCase().includes("low funds") ||
              result.message?.toLowerCase().includes("insufficient funds") ||
              result.message?.toLowerCase().includes("account balance") ||
              result.message?.toLowerCase().includes("credit limit") ||
              result.message
                ?.toLowerCase()
                .includes("already exists in our database") ||
              result.message?.toLowerCase().includes("pending order") ||
              result.message?.toLowerCase().includes("pending order for")));

        const domainStatus = isInsufficientBalance ? "pending" : "failed";
        const statusMessage = isInsufficientBalance
          ? result.message
              ?.toLowerCase()
              .includes("already exists in our database")
            ? "Domain registration is being processed."
            : "Domain registration pending due to insufficient balance"
          : `Domain registration failed: ${result.message || "Unknown error"}`;

        let failedRcOrderId = result.data?.orderid;
        if (!failedRcOrderId && isInsufficientBalance) {
          try {
            const orderIdResponse =
              await ResellerClubWrapper.getDomainOrderId(item.domainName);
            if (
              orderIdResponse.status === "success" &&
              orderIdResponse.data
            ) {
              failedRcOrderId = orderIdResponse.data;
            }
          } catch (e) {
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

        registrationResults.push({
          domainName: item.domainName,
          status: domainStatus,
          itemType: "domain",
          orderId: failedRcOrderId,
          error: result.message,
        });

        orderDomains.push({
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
          resellerClubCustomerId: customerResult.customerId,
          resellerClubContactId: customerResult.contactId,
        });
      }
    } catch (error) {
      serverLogger.error(
        `Domain registration error for ${item.domainName}:`,
        error
      );

      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

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

      registrationResults.push({
        domainName: item.domainName,
        status: domainStatus,
        itemType: "domain",
        error: errorMessage,
      });

      orderDomains.push({
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
        resellerClubCustomerId: customerResult.customerId,
        resellerClubContactId: customerResult.contactId,
      });
    }
  }

  serverLogger.info("📊 [PAYMENT-VERIFY] Domain registration summary:", {
    totalDomains: cartItems.length,
    successful: successfulDomains.length,
    successfulDomains: successfulDomains,
  });

  // Verify domain registrations and create pending records where needed
  serverLogger.info("🔍 [PAYMENT-VERIFY] Starting verification for real domains...");

  const domainsToVerify = orderDomains
    .filter((d) => d.itemType !== "hosting")
    .map((domain) => domain.domainName);

  const verificationResults =
    domainsToVerify.length > 0
      ? await DomainVerificationService.verifyMultipleDomains(domainsToVerify)
      : [];

  const pendingDomainsToCreate: Record<string, unknown>[] = [];

  for (const orderDomain of orderDomains) {
    // Create PendingDomain for both "pending" and "failed" non-hosting domains.
    // "failed" registrations (e.g. T&C error, unsupported TLD) were previously invisible
    // to admin — they now show up in the Pending Domains dashboard with the failure reason.
    if (
      (orderDomain.status === "pending" || orderDomain.status === "failed") &&
      orderDomain.itemType !== "hosting"
    ) {
      serverLogger.info(
        `📝 [PAYMENT-VERIFY] Creating pending domain record (status=${orderDomain.status}) for: ${orderDomain.domainName}`
      );

      pendingDomainsToCreate.push({
        domainName: orderDomain.domainName,
        price: orderDomain.price,
        currency: orderDomain.currency,
        registrationPeriod: orderDomain.registrationPeriod,
        userId: user._id?.toString() || "",
        orderId: orderId,
        customerId: orderDomain.resellerClubCustomerId,
        contactId: orderDomain.resellerClubContactId,
        resellerClubOrderId: orderDomain.resellerClubOrderId,
        nameServers: nameServers,
        adminContactId: customerResult.contactId,
        techContactId: customerResult.contactId,
        billingContactId: customerResult.contactId,
        status: orderDomain.status === "failed" ? "failed" : "pending",
        reason:
          orderDomain.error ||
          (orderDomain.status === "failed"
            ? "Domain registration failed - requires manual processing"
            : "Domain registration pending - requires manual processing"),
        verificationAttempts: 0,
        lastVerifiedAt: new Date(),
      });
    }
  }

  for (const verificationResult of verificationResults) {
    const orderDomain = orderDomains.find(
      (d) =>
        d.domainName === verificationResult.domainName &&
        d.itemType === "domain"
    );

    if (
      orderDomain &&
      orderDomain.status === "registered" &&
      orderDomain.itemType !== "hosting" &&
      DomainVerificationService.isPendingRegistration(verificationResult)
    ) {
      serverLogger.warn(
        `⚠️ [PAYMENT-VERIFY] Domain still available after registration: ${verificationResult.domainName}`
      );

      orderDomain.status = "pending";

      try {
        await Domain.deleteOne({
          domainName: verificationResult.domainName,
          orderId: orderId,
        });
        serverLogger.info(
          `🧹 [PAYMENT-VERIFY] Cleaned up premature Domain record for: ${verificationResult.domainName}`
        );
      } catch (cleanupError) {
        serverLogger.error(
          `❌ [PAYMENT-VERIFY] Failed to cleanup Domain record for ${verificationResult.domainName}:`,
          cleanupError
        );
      }

      pendingDomainsToCreate.push({
        domainName: verificationResult.domainName,
        price: orderDomain.price,
        currency: orderDomain.currency,
        registrationPeriod: orderDomain.registrationPeriod,
        userId: user._id?.toString() || "",
        orderId: orderId,
        customerId: orderDomain.resellerClubCustomerId,
        contactId: orderDomain.resellerClubContactId,
        resellerClubOrderId: orderDomain.resellerClubOrderId,
        nameServers: nameServers,
        adminContactId: customerResult.contactId,
        techContactId: customerResult.contactId,
        billingContactId: customerResult.contactId,
        status: "pending",
        reason:
          verificationResult.reason ||
          "Domain still available - registration likely failed due to insufficient funds",
        verificationAttempts: 1,
        lastVerifiedAt: new Date(),
      });
    } else if (
      orderDomain &&
      orderDomain.status === "registered" &&
      verificationResult.registrationStatus === "success"
    ) {
      serverLogger.info(
        `✅ [PAYMENT-VERIFY] Domain verification successful: ${verificationResult.domainName}`
      );
    }
  }

  if (pendingDomainsToCreate.length > 0) {
    serverLogger.info(
      `📝 [PAYMENT-VERIFY] Creating/updating ${pendingDomainsToCreate.length} pending domain records for admin management`
    );
    try {
      const bulkOps = pendingDomainsToCreate.map((domain) => ({
        updateOne: {
          filter: { domainName: domain.domainName },
          update: { $set: domain },
          upsert: true,
        },
      }));

      const result = await PendingDomain.bulkWrite(bulkOps);
      serverLogger.info(
        `✅ [PAYMENT-VERIFY] Successfully processed ${
          result.upsertedCount + result.modifiedCount
        } pending domain records (${result.upsertedCount} new, ${
          result.modifiedCount
        } updated)`
      );
    } catch (error) {
      serverLogger.error(
        "❌ [PAYMENT-VERIFY] Failed to create pending domain records:",
        error
      );
    }
  }

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
