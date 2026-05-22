import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { DirectAdminService, DA_SERVER_IP } from "@/lib/directadmin";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { EmailService } from "@/lib/email";
import { ZohoBooksService } from "@/lib/zohobooks";
import { getUserById } from "@/lib/services/users";
import { createOrder } from "@/lib/services/orders";
import { createPendingHosting } from "@/lib/services/pending-hostings";
import { createHosting } from "@/lib/services/hostings";
import { calculateHostingDates } from "@/lib/hosting-dates";

/**
 * POST /api/admin/hosting/provision
 * Provisions a new DirectAdmin hosting account for an existing user.
 * Restricted to Admins only.
 */
export async function POST(request: NextRequest) {
  // Parse body once at the top so the error handler can reference it too.
  interface ProvisionBody {
    userId?: string;
    domain?: string;
    packageName?: string;
    daUsername?: string;
    validityPeriod?: number;
    price?: number;
    periodUnit?: 'months' | 'days' | 'minutes';
  }
  let body: ProvisionBody = {};
  try { body = await request.json(); } catch {}

  try {
    // 1. Authenticate and check Admin role
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized. Admin access required.", 403, "FORBIDDEN");
    }

    // 2. Destructure already-parsed body
    const { userId, domain, packageName, daUsername, validityPeriod, price: manualPrice } = body;

    if (!userId || !domain || !packageName || !daUsername) {
      return secureErrorResponse("User ID, domain, package name, and DA username are required.", 400, "INVALID_INPUT");
    }

    // Validate and default validity period (defaults to 12 months if not 1)
    const period = validityPeriod === 1 ? 1 : 12;

    // 3. Find user
    const user = await getUserById(userId);
    if (!user) {
      return secureErrorResponse("User not found.", 404, "USER_NOT_FOUND");
    }

    // Capture unit if provided (useful for special plans)
    const unit = body.periodUnit || 'months';

    // We allow multiple hosting accounts per user.
    // The previous check blocking existing users is removed.

    // 4. Provision in DirectAdmin
    serverLogger.info(`Admin provisioning hosting for user ${user.email} on domain ${domain} with package ${packageName} for ${period} ${unit}(s)`);
    
    // DirectAdmin requires lowercase package names
    const daPackageName = packageName.toLowerCase();
    
    await DirectAdminService.createUser(
        daUsername,
        user.email,
        domain,
        daPackageName
    );

    serverLogger.info(`DirectAdmin: User created: ${daUsername} for domain: ${domain}`);

    // 4.5. Update DNS Nameservers to ResellerClub
    try {
      serverLogger.info(`Updating DNS nameservers for ${domain} to ResellerClub nameservers`);
      
      await DirectAdminService.updateDNSNameservers(daUsername, domain, DirectAdminService.NAMESERVERS);

      serverLogger.info(`DNS nameservers updated successfully for ${domain}`);
    } catch (dnsError: unknown) {
      // Log but don't fail the entire provisioning if DNS update fails
      const message = dnsError instanceof Error ? dnsError.message : String(dnsError);
      serverLogger.warn(`Failed to update DNS nameservers for ${domain}: ${message}`);
    }

    // 5. Update user in DB using centralized date utility with selected validity
    const { registeredAt, expiresAt } = calculateHostingDates(period, unit);
    
    // Only update the primary DA username link if it's not set.
    // For subsequent accounts, we rely on email matching in the stats API.
    if (!user.directAdminUsername) {
        user.directAdminUsername = daUsername;
        // Only set primary dates if this is the first account
        user.hostingCreatedAt = registeredAt;
        user.hostingExpiresAt = expiresAt;
    }
    // We always save the user to ensure any other changes are persisted (though here we only changed DA fields)
    await user.save();

    // 5b. Create Order record for tracking
    try {
        const HostingPlan = (await import("@/models/HostingPlan")).default;
        
        // Find the hosting plan
        const plan = await HostingPlan.findOne({ directAdminPackage: packageName });
        
        const orderId = `ORD-${Date.now()}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
        const paymentId = `ADMIN-PAY-${Date.now()}`;
        
        // Use manual price if provided, otherwise use plan price or default to 0
        const totalPrice = manualPrice !== undefined ? Number(manualPrice) : (plan?.price || 0);

        const orderPayload = {
            orderId: orderId,
            userId: user._id,
            userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
            userEmail: user.email,
            totalAmount: totalPrice, 
            currency: "INR",
            paymentStatus: "completed",
            paymentMethod: "admin_provision",
            status: "completed",
            paymentId: paymentId,
            razorpayOrderId: `ADMIN-RZP-${Date.now()}`,
            razorpayPaymentId: paymentId,
            razorpaySignature: "admin-provision-signature",
            amount: totalPrice,
            domains: [{
                domainName: domain,
                price: totalPrice,
                currency: "INR",
                registrationPeriod: period,
                status: "registered",
                itemType: "hosting",
                dnsProvider: "directadmin",
                hostingPlan: plan ? {
                    planId: plan.planId,
                    name: plan.name,
                    price: plan.price,
                    currency: plan.currency
                } : undefined,
                registeredAt: registeredAt,
                expiresAt: expiresAt,
                bookingStatus: [{
                    step: "domain_registered",
                    message: "Hosting provisioned by admin",
                    timestamp: registeredAt,
                    progress: 100
                }]
            }],
            paymentVerification: {
                verifiedAt: new Date(),
                paymentStatus: "captured",
                paymentAmount: totalPrice,
                paymentCurrency: "INR",
                razorpayOrderId: `ADMIN-RZP-${Date.now()}`
            }
        };

        serverLogger.info(`Attempting to create Order for ${domain} with payload: ${JSON.stringify(orderPayload, null, 2)}`);
        
        const newOrder = await createOrder(orderPayload);
        serverLogger.info(`Created Order record for admin-provisioned hosting: ${domain} (Price: ${totalPrice})`);

        // 5c. Generate Zoho Invoice
        try {
            const zohoService = ZohoBooksService.getInstance();
            const invoiceItems = [{
                domainName: domain,
                price: totalPrice,
                registrationPeriod: period,
                itemType: 'hosting',
                hostingPlan: plan ? {
                    name: plan.name || packageName
                } : undefined
            }];
            
            await zohoService.createInvoice(
                newOrder as unknown as Parameters<typeof zohoService.createInvoice>[0],
                user,
                invoiceItems,
                'Admin Provision'
            );
            serverLogger.info(`Generated Zoho Invoice for admin provision: ${domain}`);

            // 5d. Generate Zoho Recurring Invoice for future renewals
            try {
                // Recurring invoice creation disabled to avoid "due invoices"
                interface RecurringResult {
                    success: boolean;
                    recurringInvoiceId?: string;
                    error?: string;
                }
                const recurringResults: RecurringResult[] = []; // await zohoService.createRecurringInvoice(

                if (recurringResults && recurringResults.length > 0) {
                     let orderModified = false;
                     // We only have one domain/item here
                     if (recurringResults[0].success && recurringResults[0].recurringInvoiceId) {
                         type OrderDomainSub = (typeof newOrder.domains)[number] & {
                             zohoRecurringInvoiceId?: string;
                             zohoRecurringProfileStatus?: string;
                         };
                         const domainItem = newOrder.domains.find((d: OrderDomainSub) => d.domainName === domain) as OrderDomainSub | undefined;
                         if (domainItem) {
                             domainItem.zohoRecurringInvoiceId = recurringResults[0].recurringInvoiceId;
                             domainItem.zohoRecurringProfileStatus = 'created';
                             orderModified = true;
                         }
                         serverLogger.info(`Generated Zoho Recurring Invoice for admin provision: ${domain} (ID: ${recurringResults[0].recurringInvoiceId})`);
                     } else {
                         serverLogger.warn(`Failed to create Recurring Invoice: ${recurringResults[0].error}`);
                     }

                     if (orderModified) {
                         await newOrder.save();
                     }
                }
            } catch (recurringError: unknown) {
                const message = recurringError instanceof Error ? recurringError.message : String(recurringError);
                serverLogger.warn(`Failed to trigger recurring invoice generation: ${message}`);
            }

        } catch (zohoError: unknown) {
             const message = zohoError instanceof Error ? zohoError.message : String(zohoError);
             serverLogger.warn(`Failed to generate Zoho Invoice for admin provision: ${message}`);
        }
        // 5e. Create Hosting Record for visibility in Services Modal
        try {
            await createHosting({
                userId: user._id,
                domainName: domain,
                planId: plan?.planId || packageName,
                name: plan?.name || packageName,
                serverPackage: packageName,
                status: "active",
                startDate: registeredAt,
                expiryDate: expiresAt,
                directAdminUsername: daUsername,
                orderId: orderId,
                paymentId: paymentId,
            });
            serverLogger.info(`Created Hosting record for ${domain}`);
        } catch (hostingError: unknown) {
            serverLogger.error(`Failed to create Hosting record for ${domain}:`, hostingError);
        }

    } catch (orderError: unknown) {
        serverLogger.warn(`Failed to create Order record for ${domain}:`, orderError);
        // Don't fail the entire provisioning if Order creation fails
    }

    // 6. Send Notification Email
    try {
        await EmailService.sendHostingProvisionedEmail(
            user.email,
            user.firstName || 'User',
            {
                domainName: domain,
                packageName: packageName,
                serverIp: DA_SERVER_IP,
                nameservers: DirectAdminService.NAMESERVERS
            }
        );
        serverLogger.info(`Hosting provision email sent to ${user.email}`);
    } catch (emailError: unknown) {
        const message = emailError instanceof Error ? emailError.message : String(emailError);
        serverLogger.warn(`Failed to send hosting provision email to ${user.email}: ${message}`);
    }

    return secureJsonResponse({ 
      success: true, 
      message: `Hosting provisioned successfully for ${user.email} on ${domain}.`,
      data: {
          username: daUsername,
          domain: domain,
          package: packageName
      }
    });

  } catch (error: unknown) {
    interface DaError { status?: number; code?: string; message?: string }
    const e = (error && typeof error === 'object' ? error : {}) as DaError;
    serverLogger.error(`Admin Hosting Provision Error:`, e.message);

    // Explicitly handle DirectAdmin Connection Errors (Admin Only)
    if (e.status === 503 || e.code === 'DA_SERVER_DOWN') {
       return secureErrorResponse(
         "DirectAdmin Server is unreachable. Provisioning failed.",
         503,
         "DA_SERVER_DOWN"
       );
    }

    // Check for specific DA errors that we might want to pass through
    const message = e.message || "Failed to provision hosting";

    // Save to PendingHosting
    try {
        const { userId, domain, packageName, daUsername } = body;
        
        if (userId && domain && packageName && daUsername) {
            await createPendingHosting({
                userId,
                domain,
                package: packageName,
                daUsername,
                error: message,
                status: 'failed'
            });
            serverLogger.info(`Saved failed hosting provision to pending list for ${domain}`);
            
            return secureJsonResponse({
                success: false,
                message: `Provisioning failed: ${message}. Added to Pending Hostings list for retry.`,
                data: { savedToPending: true }
            });
        }
    } catch (saveError) {
        serverLogger.error('Failed to save pending hosting:', saveError);
    }
    
    return secureErrorResponse(
      message,
      500,
      "PROVISION_FAILED",
      error // Log internal error details
    );
  }
}

