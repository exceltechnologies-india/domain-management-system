import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { serverLogger } from "@/lib/server-logger";
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import PendingDomain from "@/models/PendingDomain";
import Order from "@/models/Order";
import User from "@/models/User";
import Domain from "@/models/Domain";
import { getToken } from "next-auth/jwt";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await connectDB();

    // Verify admin authentication - Try JWT first, then NextAuth session
    let user = await AuthService.getUserFromRequest(request);
    
    // If no user from JWT, try NextAuth session via getToken (works with cookies)
    if (!user) {
      const token = await getToken({ 
        req: request,
        secret: AUTH_SECRET,
      });
      
      if (token?.id) {
        // Get user by id from NextAuth token
        user = await User.findById(token.id).select("-password");
        
        if (!user || !user.isActive) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
    }

    // Check if user is admin
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let query: any = { _id: id };
    if (mongoose.Types.ObjectId.isValid(id)) {
      query = { $or: [{ _id: id }, { _id: new mongoose.Types.ObjectId(id) }] };
    }

    const pendingDomain = await PendingDomain.findOne(query).populate(
      "userId",
      "firstName lastName email phone companyName"
    );

    if (!pendingDomain) {
      return NextResponse.json(
        { error: "Pending domain not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      pendingDomain,
    });
  } catch (error) {
    serverLogger.error("Admin pending domain fetch error:", error);
    return NextResponse.json(
      { error: "Failed to fetch pending domain" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await connectDB();

    // Verify admin authentication - Try JWT first, then NextAuth session
    let user = await AuthService.getUserFromRequest(request);
    
    // If no user from JWT, try NextAuth session via getToken (works with cookies)
    if (!user) {
      const token = await getToken({ 
        req: request,
        secret: AUTH_SECRET,
      });
      
      if (token?.id) {
        // Get user by id from NextAuth token
        user = await User.findById(token.id).select("-password");
        
        if (!user || !user.isActive) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
    }

    // Check if user is admin
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { status, adminNotes, reason } = body;

    let query: any = { _id: id };
    if (mongoose.Types.ObjectId.isValid(id)) {
      query = { $or: [{ _id: id }, { _id: new mongoose.Types.ObjectId(id) }] };
    }

    const pendingDomain = await PendingDomain.findOne(query);

    if (!pendingDomain) {
      return NextResponse.json(
        { error: "Pending domain not found" },
        { status: 404 }
      );
    }

    // Update fields
    if (status) {
      pendingDomain.status = status;
    }
    if (adminNotes !== undefined) {
      pendingDomain.adminNotes = adminNotes;
    }
    if (reason) {
      pendingDomain.reason = reason;
    }

    await pendingDomain.save();

    // SYNC WITH ORDER COLLECTION
    // When admin updates pending domain status, also update the corresponding domain in the Order collection
    if (status && pendingDomain.orderId) {
      try {
        const order = await Order.findOne({ orderId: pendingDomain.orderId });

        if (order) {
          // Find and update the matching domain in the order
          const domainIndex = order.domains.findIndex(
            (d: any) => d.domainName === pendingDomain.domainName
          );

          if (domainIndex !== -1) {
            // Map pending domain status to order domain status
            const domainStatus =
              status === "registered" ? "registered" : "failed";

            order.domains[domainIndex].status = domainStatus;

            // Update error message if status is failed
            if (status === "failed" && reason) {
              order.domains[domainIndex].error = reason;
            }

            // Add booking status update
            order.domains[domainIndex].bookingStatus =
              order.domains[domainIndex].bookingStatus || [];
            order.domains[domainIndex].bookingStatus.push({
              step:
                status === "registered" ? "domain_registered" : "domain_failed",
              message:
                status === "registered"
                  ? "Domain registered by admin"
                  : `Domain registration failed: ${reason || "Unknown reason"}`,
              timestamp: new Date(),
              progress: status === "registered" ? 100 : 0,
            });

            await order.save();
            serverLogger.info(
              `✅ Synced pending domain status to Order collection: ${pendingDomain.domainName} -> ${domainStatus}`
            );
          }
        }
      } catch (syncError) {
        serverLogger.error(
          "Failed to sync pending domain status with Order:",
          syncError
        );
        // Don't fail the request if sync fails - pending domain is still updated
      }
    }

    return NextResponse.json({
      success: true,
      message: "Pending domain updated successfully and synced with order",
      pendingDomain,
    });
  } catch (error) {
    serverLogger.error("Admin pending domain update error:", error);
    return NextResponse.json(
      { error: "Failed to update pending domain" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const reqId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    const { id: pendingDomainId } = await params;
    serverLogger.info(`[${reqId}] DELETE /api/admin/pending-domains/${pendingDomainId} started`);
    await connectDB();

    // Verify admin authentication - Try JWT first, then NextAuth session
    let user = await AuthService.getUserFromRequest(request);

    // If no user from JWT, try NextAuth session via getToken (works with cookies)
    if (!user) {
      const token = await getToken({
        req: request,
        secret: AUTH_SECRET,
      });

      if (token?.id) {
        // Get user by id from NextAuth token
        user = await User.findById(token.id).select("-password");

        if (!user || !user.isActive) {
          serverLogger.warn(`[${reqId}] User not found or inactive`);
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
    }

    // Check if user is admin
    if (!user || user.role !== "admin") {
      serverLogger.warn(`[${reqId}] Unauthorized access attempt by ${user?.email}`);
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let query: any = { _id: pendingDomainId };
    if (mongoose.Types.ObjectId.isValid(pendingDomainId)) {
      query = { $or: [{ _id: pendingDomainId }, { _id: new mongoose.Types.ObjectId(pendingDomainId) }] };
    }

    const pendingDomain = await PendingDomain.findOne(query).populate('userId');

    if (!pendingDomain) {
      serverLogger.warn(`[${reqId}] Pending domain not found: ${pendingDomainId}`);
      return NextResponse.json(
        { error: "Pending domain not found" },
        { status: 404 }
      );
    }

    // Check if permanent deletion is requested
    const url = new URL(request.url);
    const isPermanent = url.searchParams.get("permanent") === "true";

    if (isPermanent) {
      // PERMANENT DELETION
      serverLogger.info(`[${reqId}] Permanently deleting pending domain: ${pendingDomainId}`);
      
      let registrarCancelled = false;
      let registrarMessage = "";

      // 1. CANCEL AT REGISTRAR (ResellerClub)
      let rcOrderId = pendingDomain.resellerClubOrderId;
      
      // Safety net: If order ID is missing, try to find it via API searching by domain name
      if (!rcOrderId) {
        try {
          serverLogger.info(`[${reqId}] ResellerClub order ID missing in DB, searching via API for: ${pendingDomain.domainName}`);
          const searchResult = await ResellerClubWrapper.getDomainOrderId(pendingDomain.domainName);
          if (searchResult.status === 'success' && searchResult.data) {
            rcOrderId = searchResult.data;
            serverLogger.info(`[${reqId}] ✅ Found Order ID via search: ${rcOrderId}`);
          }
        } catch (searchError) {
          serverLogger.warn(`[${reqId}] ⚠️ Failed to search for Order ID via API:`, searchError);
        }
      }

      if (rcOrderId) {
        try {
          serverLogger.info(`[${reqId}] Calling ResellerClub to delete order: ${rcOrderId}`);
          const rcResult = await ResellerClubWrapper.deleteDomainOrder(rcOrderId);
          
          if (rcResult.status === "success") {
            registrarCancelled = true;
            serverLogger.info(`[${reqId}] ✅ Successfully cancelled order at ResellerClub`);
          } else {
            registrarMessage = rcResult.message || "Failed to cancel at registrar";
            serverLogger.warn(`[${reqId}] ⚠️ ResellerClub cancellation returned error: ${registrarMessage}`);
          }
        } catch (rcError: any) {
          registrarMessage = rcError.message || "Registrar API error";
          serverLogger.error(`[${reqId}] ❌ Failed to call ResellerClub delete API:`, rcError);
        }
      } else {
        serverLogger.info(`[${reqId}] No ResellerClub order ID found even after search, skipping registrar cancellation`);
      }

      // 2. SYNC WITH ORDER COLLECTION - Update status to 'cancelled'
      if (pendingDomain.orderId) {
        try {
          const order = await Order.findOne({ orderId: pendingDomain.orderId });
          if (order) {
            const domainIndex = order.domains.findIndex(
              (d: any) => d.domainName === pendingDomain.domainName
            );
            if (domainIndex !== -1) {
              order.domains[domainIndex].status = 'cancelled';
              order.domains[domainIndex].bookingStatus = order.domains[domainIndex].bookingStatus || [];
              order.domains[domainIndex].bookingStatus.push({
                step: 'domain_failed',
                message: `Domain registration cancelled by admin${registrarCancelled ? " (Confirmed with registrar)" : ""}`,
                timestamp: new Date(),
                progress: 0,
              });
              order.markModified('domains');
              await order.save();
              serverLogger.info(`[${reqId}] ✅ Updated Order ${order.orderId} status to 'cancelled'`);
            }
          }
        } catch (syncError) {
          serverLogger.error(`[${reqId}] Failed to sync 'cancelled' status to Order:`, syncError);
        }
      }

      // 3. DELETE PENDING RECORD
      await PendingDomain.deleteOne(query);
      serverLogger.info(`[${reqId}] Successfully deleted pending domain record: ${pendingDomainId}`);
      
      // 4. CLEANUP ANY PREMATURE DOMAIN RECORDS
      try {
        await Domain.deleteMany({
          domainName: pendingDomain.domainName,
          orderId: pendingDomain.orderId,
        });
      } catch (cleanupError) {
         serverLogger.error(`[${reqId}] Cleanup error:`, cleanupError);
      }

      return NextResponse.json({
        success: true,
        message: registrarCancelled 
          ? "Pending domain permanently deleted and cancelled at ResellerClub" 
          : "Pending domain permanently deleted locally" + (registrarMessage ? ` (Registrar: ${registrarMessage})` : ""),
        registrarStatus: registrarCancelled ? "cancelled" : "skipped_or_failed"
      });
    }

    // SOFT DELETE (ARCHIVE)
    serverLogger.info(`[${reqId}] Archiving pending domain: ${pendingDomainId}`);
    
    // Archive the pending domain
    await PendingDomain.findOneAndUpdate(query, {
      isArchived: true,
      archivedAt: new Date(),
      archivedBy: user.email,
      status: 'failed', // Update status to failed when archiving
    });
    serverLogger.info(`[${reqId}] DB updated for archive: ${pendingDomainId}`);

    // SYNC WITH ORDER COLLECTION - Update order domain status to failed
    if (pendingDomain.orderId) {
      try {
        serverLogger.info(`[${reqId}] Syncing with Order: ${pendingDomain.orderId}`);
        const order = await Order.findOne({ orderId: pendingDomain.orderId });

        if (order) {
          // Find and update the matching domain in the order
          const domainIndex = order.domains.findIndex(
            (d: any) => d.domainName === pendingDomain.domainName
          );

          if (domainIndex !== -1) {
            // Update domain status to failed
            order.domains[domainIndex].status = 'failed';
            order.domains[domainIndex].error = pendingDomain.reason || 'Domain registration failed - Archived by admin';

            // Add booking status update
            order.domains[domainIndex].bookingStatus = order.domains[domainIndex].bookingStatus || [];
            order.domains[domainIndex].bookingStatus.push({
              step: 'domain_failed',
              message: `Domain registration failed: ${pendingDomain.reason || 'Archived by admin'}`,
              timestamp: new Date(),
              progress: 0,
            });

            order.markModified('domains');
            await order.save();
            serverLogger.info(
              `[${reqId}] ✅ Synced archived pending domain to Order collection: ${pendingDomain.domainName} -> failed`
            );

            // CLEANUP: Also delete any incorrectly created Domain records for this domain and order
            try {
              const domainCleanup = await Domain.deleteMany({
                domainName: pendingDomain.domainName,
                orderId: pendingDomain.orderId,
              });
              if (domainCleanup.deletedCount > 0) {
                serverLogger.info(
                  `🧹 [ADMIN-DELETE] Cleaned up ${domainCleanup.deletedCount} premature Domain records for ${pendingDomain.domainName}`
                );
              }
            } catch (cleanupError) {
              serverLogger.error(
                `❌ [ADMIN-DELETE] Failed to cleanup Domain records:`,
                cleanupError
              );
            }

            // Send failure email to user
            try {
              const customer = pendingDomain.userId as any;
              // Check if customer object is populated and has email (it might be just an ID if populate failed)
              if (customer && typeof customer === 'object' && customer.email) {
                serverLogger.info(`[${reqId}] Sending failure email to: ${customer.email}`);
                // Import EmailService
                const { EmailService } = await import('@/lib/email');

                // Calculate subtotal (assuming 18% GST)
                const subtotal = order.amount ? (order.amount / 1.18) : 0;

                // Check if payment was successful (order status is 'completed' or has paymentVerification)
                const paymentWasSuccessful = order.status === 'completed' || 
                  (order.paymentVerification && order.paymentVerification.paymentStatus === 'success');

                // Send PO email - payment was successful but registration failed
                await EmailService.sendPurchaseOrderEmail(
                  customer.email,
                  `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || customer.email,
                  {
                    orderId: order.orderId,
                    purchaseOrderNumber: order.purchaseOrderNumber || '',
                    invoiceNumber: order.invoiceNumber || '',
                    amount: order.amount || 0,
                    subtotal: subtotal,
                    currency: order.currency || 'INR',
                    paymentStatus: paymentWasSuccessful ? 'success' : 'failed',
                    registrationFailed: paymentWasSuccessful, // Indicate registration failed after successful payment
                    paymentId: order.paymentId || '',
                    createdAt: order.createdAt || new Date(),
                    domains: [{
                      domainName: pendingDomain.domainName,
                      price: pendingDomain.price,
                      registrationPeriod: pendingDomain.registrationPeriod,
                      itemType: 'domain',
                    }],
                  }
                );

                serverLogger.info(`[${reqId}] ✅ Sent failure email to user: ${customer.email}`);
              } else {
                 serverLogger.warn(`[${reqId}] Skipping email - Customer data missing or invalid`, customer);
              }
            } catch (emailError) {
              serverLogger.error(`[${reqId}] Failed to send failure email:`, emailError);
              // Don't fail the request if email fails
            }
          } else {
             serverLogger.warn(`[${reqId}] Domain ${pendingDomain.domainName} not found in Order ${order.orderId}`);
          }
        } else {
           serverLogger.warn(`[${reqId}] Order not found: ${pendingDomain.orderId}`);
        }
      } catch (syncError) {
        serverLogger.error(
          `[${reqId}] Failed to sync archived pending domain with Order:`,
          syncError
        );
        // Don't fail the request if sync fails - pending domain is still archived
      }
    } else {
       serverLogger.info(`[${reqId}] No Order ID associated with pending domain`);
    }

    return NextResponse.json({
      success: true,
      message: "Pending domain archived successfully",
    });
  } catch (error: any) {
    serverLogger.error(`[${reqId ?? 'unknown'}] Admin pending domain archive/delete error:`, error);
    return NextResponse.json(
      { error: `Failed to process pending domain: ${error.message}` }, // Expose specific error to UI
      { status: 500 }
    );
  }
}
