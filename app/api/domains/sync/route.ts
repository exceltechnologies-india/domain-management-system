import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import User from "@/models/User";
import Order from "@/models/Order";
import { ResellerClubAPI } from "@/lib/resellerclub";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await connectDB();

    // Get user from database
    const dbUser = await User.findById(user._id);
    if (!dbUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Check if user has ResellerClub customer ID
    if (!dbUser.resellerClubCustomerId) {
      
      // Try to look up customer ID by email
      const customerLookup = await ResellerClubAPI.getCustomerId(user.email);
      if (customerLookup.status === "success" && customerLookup.customerId) {
        dbUser.resellerClubCustomerId = customerLookup.customerId;
        await dbUser.save();
      } else {
        return NextResponse.json({
          success: false,
          code: "NO_LINKED_ACCOUNT",
          error: "No domain registrar account linked yet",
          message: "This account is not linked to a domain registrar customer. Domains will appear here once you register one."
        }, { status: 200 }); // Return 200 instead of 404 to avoid console errors for new users
      }
    }

    const customerId = dbUser.resellerClubCustomerId!;

    // Fetch all domains from ResellerClub
    const domainsResult = await ResellerClubAPI.getCustomerDomains(customerId);
    
    if (domainsResult.status !== "success" || !domainsResult.data) {
      serverLogger.error(`❌ [DOMAIN-SYNC] Failed to fetch domains:`, domainsResult.message);
      return NextResponse.json({
        error: "Failed to fetch domains from our registrar",
        message: domainsResult.message
      }, { status: 500 });
    }

    const domains = domainsResult.data;
    const domainCount = Object.keys(domains).length;

    if (domainCount === 0) {
      return NextResponse.json({
        success: true,
        message: "No domains found in your registrar account",
        imported: 0,
        skipped: 0,
        failed: 0
      });
    }

    let imported = 0;
    let skipped = 0;
    let failed = 0;
    const results: any[] = [];

    // Process each domain
    for (const [key, domainData] of Object.entries(domains)) {
      try {
        // Skip metadata keys
        if (key === 'recsonpage' || key === 'recsindb') continue;

        const domain = domainData as any;
        // The API returns flattened keys like 'entity.description' for the domain name
        // and 'orders.orderid' for the order ID
        const domainName = domain['entity.description'] || domain.domainname || domain.domain;
        const orderId = domain['orders.orderid'] || key;

        if (!domainName) {
          skipped++;
          continue;
        }



        // Check if domain already exists in database
        const existingOrder = await Order.findOne({
          "domains.domainName": domainName,
          userId: user._id,
          isDeleted: { $ne: true }
        });

        if (existingOrder) {
          skipped++;
          results.push({
            domain: domainName,
            status: "skipped",
            reason: "Already exists in database"
          });
          continue;
        }

        // Get expiry and registration dates from the domain data
        // orders.endtime and orders.creationtime are Unix timestamps
        const expiryTimestamp = domain['orders.endtime'];
        const creationTimestamp = domain['orders.creationtime'];
        const expiryDate = expiryTimestamp ? new Date(parseInt(expiryTimestamp) * 1000) : null;
        const registrationDate = creationTimestamp ? new Date(parseInt(creationTimestamp) * 1000) : null;

        // Map RC currentstatus to local status — only "Active" means fully registered.
        // On-hold, InvoicePaid, Processing, Suspended, etc. are imported as "pending"
        // so they appear in admin pending domains rather than the registered list.
        const rcCurrentStatus = (domain['orders.currentstatus'] || '').toLowerCase().trim();
        const domainStatus: "registered" | "pending" =
          rcCurrentStatus === 'active' ? 'registered' : 'pending';

        // Create order record for the imported domain
        const newOrder = new Order({
          orderId: `SYNC-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          purchaseOrderNumber: `PO-SYNC-${Date.now().toString().slice(-6)}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`,
          userId: user._id,
          paymentId: `SYNC-${orderId}`,
          razorpayOrderId: `SYNC-${orderId}`,
          razorpayPaymentId: `SYNC-${orderId}`,
          razorpaySignature: `SYNC-${orderId}`,
          amount: 0, // Synced domains have no payment in our system
          currency: "INR",
          status: "completed",
          domains: [{
            domainName: domainName,
            price: 0,
            currency: "INR",
            registrationPeriod: 1,
            status: domainStatus,
            bookingStatus: [{
              step: domainStatus === 'registered' ? 'domain_registered' : 'payment_verified',
              message: domainStatus === 'registered'
                ? 'Domain synced from ResellerClub'
                : `Domain synced from ResellerClub — RC status: ${domain['orders.currentstatus'] || 'unknown'} (pending manual review)`,
              timestamp: new Date(),
              progress: domainStatus === 'registered' ? 100 : 30,
            }],
            resellerClubOrderId: orderId,
            resellerClubCustomerId: customerId.toString(),
            expiresAt: expiryDate,
            dnsActivated: false
          }],
          successfulDomains: domainStatus === 'registered' ? [domainName] : [],
          paymentVerification: {
            verifiedAt: new Date(),
            paymentStatus: "synced",
            paymentAmount: 0,
            paymentCurrency: "INR",
            razorpayOrderId: `SYNC-${orderId}`
          }
        });

        await newOrder.save();
        
        imported++;
        results.push({
          domain: domainName,
          status: "imported",
          orderId: orderId,
          expiryDate: expiryDate
        });
      } catch (error) {
        serverLogger.error(`❌ [DOMAIN-SYNC] Failed to import domain:`, error);
        failed++;
        results.push({
          domain: domainData,
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown error"
        });
      }
    }

    return NextResponse.json({
      success: true,
      message: `Domain sync completed. Imported ${imported} domain(s), skipped ${imported} existing domain(s), ${failed} failed.`,
      imported,
      skipped,
      failed,
      results
    });

  } catch (error) {
    serverLogger.error("❌ [DOMAIN-SYNC] Sync error:", error);
    return NextResponse.json({
      error: "Failed to sync domains",
      message: error instanceof Error ? error.message : "Unknown error"
    }, { status: 500 });
  }
}
