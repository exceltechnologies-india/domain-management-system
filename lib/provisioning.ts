import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import { ResellerClubAPI } from "@/lib/resellerclub";
import { DirectAdminService } from "@/lib/directadmin";
import { EmailService } from "@/lib/email";
import { DomainVerificationService } from "@/lib/domain-verification";
import PendingDomain from "@/models/PendingDomain";
import { serverLogger } from "@/lib/server-logger";

export class ProvisioningService {
  
  static async provisionOrder(order: any, user: any) {
    
    const cartItems = order.domains; // Assuming structure matches
    const successfulDomains: string[] = [];
    const failedDomains: any[] = [];
    const pendingDomains: any[] = [];
    const registrationResults: any[] = [];

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
                    email: user.email,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    phone: user.phone,
                    phoneCc: user.phoneCc || '91',
                    companyName: user.companyName,
                    address: {
                        line1: user.address?.line1 || user.address || '',
                        city: user.city || user.address?.city || '',
                        state: user.state || user.address?.state || '',
                        country: user.country || user.address?.country || 'IN',
                        zipcode: user.zip || user.address?.zipcode || ''
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
                    (item as any).tldAttributes
                );
                
                if (result.status === 'success' || result.status === 'Active') {
                     item.status = 'registered';
                     successfulDomains.push(item.domainName);
                } else {
                     throw new Error(result.message || "Registration Failed");
                }
            }
        } catch (error: any) {
            serverLogger.error(`❌ [Provisioning] Failed for ${item.domainName}:`, error);
            item.status = 'failed';
            item.error = error.message;
            failedDomains.push({ domainName: item.domainName, error: error.message });
        }
    }
    
    // Save Order progress
    await order.save();
    
    // Send Confirmation Email if new successes
    if (successfulDomains.length > 0) {
        await EmailService.sendOrderConfirmationEmail(
            user.email, 
            `${user.firstName} ${user.lastName}`,
            {
                orderId: order.orderId,
                successfulDomains: successfulDomains.map(d => ({ domainName: d, price: 0, registrationPeriod: 1 })), // simplified
                // ... populate other fields
            } as any
        );
    }
    
    return { successfulDomains, failedDomains };
  }
}
