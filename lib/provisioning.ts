import { ResellerClubAPI } from "@/lib/resellerclub";
import { DirectAdminService } from "@/lib/directadmin";
import { EmailService } from "@/lib/email";
import { serverLogger } from "@/lib/server-logger";
import type { HydratedDocument } from "mongoose";
import type { IOrder } from "@/models/Order";
import type { IUser } from "@/models/User";

interface FailedDomain {
  domainName: string;
  error: string;
}

export class ProvisioningService {
  static async provisionOrder(
    order: HydratedDocument<IOrder>,
    user: IUser
  ): Promise<{ successfulDomains: string[]; failedDomains: FailedDomain[] }> {
    // The function reads address fields defensively — older user docs put
    // city/state/country/zip at the top level rather than under `address`.
    // Narrow once via a structural type so the reads below are typed.
    const u = user as IUser & {
      city?: string;
      state?: string;
      country?: string;
      zip?: string;
    };
    const cartItems = order.domains;
    const successfulDomains: string[] = [];
    const failedDomains: FailedDomain[] = [];

    // Initialize services
    // ResellerClubAPI is static

    for (const item of cartItems) {
        // Skip if already processed
        if (item.status === 'registered' || item.status === 'processing') {
            if (item.status === 'registered') successfulDomains.push(item.domainName);
            continue;
        }


        
        try {
            if (item.itemType === 'hosting') {
                // Hosting Provisioning Logic
                const planId = item.hostingPlan?.planId;
                const domainName = item.domainName;
                const package_name = item.hostingPlan?.serverPackage || 'Starter'; // fallback
                
                // Idempotency: Check if user exists on DA? 
                // DirectAdminService usually handles creation.
                const daResult = await DirectAdminService.createUser(
                    domainName.replace(/[^a-z0-9]/g, '').substring(0, 8), // username
                    user.email,
                    domainName, // domain
                    package_name,
                    process.env.DA_IP || 'server-ip' // ip
                );
                
                // Assuming daResult success
                item.status = 'registered';
                successfulDomains.push(domainName);
                
            } else {
                // Domain Registration Logic
                // Use ResellerClub
                const customerResult = await ResellerClubAPI.getOrCreateCustomerAndContact({
                    email: u.email,
                    firstName: u.firstName,
                    lastName: u.lastName,
                    phone: u.phone,
                    phoneCc: u.phoneCc || '91',
                    companyName: u.companyName,
                    address: {
                        line1: u.address?.line1 || '',
                        city: u.city || u.address?.city || '',
                        state: u.state || u.address?.state || '',
                        country: u.country || u.address?.country || 'IN',
                        zipcode: u.zip || u.address?.zipcode || '',
                    }
                });

                if (!customerResult.customerId || !customerResult.contactId) {
                    throw new Error("Failed to create customer/contact");
                }
                
                // Register
                // We need to use ResellerClubWrapper or API directly. 
                // Let's use ResellerClubAPI if it exposes register, or the Wrapper.
                // Looking at verify/route.ts, it uses ResellerClubWrapper.registerDomain
                // Let's import Wrapper at top and use it here.
                const { ResellerClubWrapper } = await import("@/lib/resellerclub-wrapper");
                
                const result = await ResellerClubWrapper.registerDomain(
                    item.domainName,
                    item.registrationPeriod,
                    customerResult.customerId,
                    undefined, // ns
                    {
                        admin: customerResult.contactId,
                        tech: customerResult.contactId,
                        billing: customerResult.contactId
                    },
                    (item as unknown as { tldAttributes?: Record<string, string> }).tldAttributes
                );
                
                if (result.status === 'success' || result.status === 'Active') {
                     item.status = 'registered';
                     successfulDomains.push(item.domainName);
                } else {
                     throw new Error(result.message || "Registration Failed");
                }
            }
        } catch (error: unknown) {
            const errMessage = error instanceof Error ? error.message : String(error);
            serverLogger.error(`❌ [Provisioning] Failed for ${item.domainName}:`, error);
            item.status = 'failed';
            item.error = errMessage;
            failedDomains.push({ domainName: item.domainName, error: errMessage });
        }
    }
    
    // Save Order progress
    await order.save();
    
    // Send Confirmation Email if new successes
    if (successfulDomains.length > 0) {
        // Email helper expects a richer Order projection; we pass a minimal
        // synthetic shape so the success notification still fires. Narrow cast
        // because the historic email signature isn't worth restructuring here.
        await EmailService.sendOrderConfirmationEmail(
            user.email,
            `${user.firstName} ${user.lastName}`,
            {
                orderId: order.orderId,
                successfulDomains: successfulDomains.map(d => ({ domainName: d, price: 0, registrationPeriod: 1 })),
            } as unknown as Parameters<typeof EmailService.sendOrderConfirmationEmail>[2]
        );
    }
    
    return { successfulDomains, failedDomains };
  }
}
