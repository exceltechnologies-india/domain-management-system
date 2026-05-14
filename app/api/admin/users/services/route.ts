export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';

import { getServerSession } from 'next-auth';
import connectDB from '@/lib/mongodb';
import { DirectAdminService } from '@/lib/directadmin';
import User from '@/models/User';
import Domain from '@/models/Domain';
import Hosting from '@/models/Hosting';
import { authOptions } from '@/lib/auth-config';
import { serverLogger } from '@/lib/server-logger';

export async function GET(request: Request) {
  try {
    // 1. Check Authentication & Admin Role
    const session = await getServerSession(authOptions);

    if (!session || !session.user || (session.user as any).role !== 'admin') {
      return NextResponse.json(
        { error: 'Unauthorized access' },
        { status: 401 }
      );
    }

    await connectDB();

    // 2. Aggregation Pipeline to find users with services
    const usersWithServices = await User.aggregate([
      // Stage 0: Exclude deleted users
      {
        $match: {
          isDeleted: { $ne: true }
        }
      },
      // Stage 1: Lookup Domains
      {
        $lookup: {
          from: 'domains',
          localField: '_id',
          foreignField: 'userId',
          as: 'domains'
        }
      },
      // Stage 2: Lookup Hosting
      {
        $lookup: {
          from: 'hostings',
          localField: '_id',
          foreignField: 'userId',
          as: 'hosting'
        }
      },
      // Stage 2.5: Removed filter to include ALL services (active, expired, suspended)
      // We want admins to see everything.
      /*
      {
        $addFields: {
          domains: {
            $filter: {
              input: "$domains",
              as: "d",
              cond: {
                $and: [
                  { $eq: ["$$d.status", "registered"] },
                  { $gt: ["$$d.expiresAt", new Date()] }
                ]
              }
            }
          },
          hosting: {
            $filter: {
              input: "$hosting",
              as: "h",
              cond: {
                $and: [
                  { $in: ["$$h.status", ["active", "suspended"]] },
                  { $gt: ["$$h.expiryDate", new Date()] }
                ]
              }
            }
          }
        }
      },
      */
      // Stage 3: Filter for users who have at least one domain OR one hosting
      {
        $match: {
          $or: [
            { 'domains.0': { $exists: true } },
            { 'hosting.0': { $exists: true } }
          ]
        }
      },
      // Stage 4: Project only necessary fields (optimize payload)
      {
        $project: {
          _id: 1,
          firstName: 1,
          lastName: 1,
          email: 1,
          role: 1,
          isActive: 1,
          createdAt: 1,
          directAdminUsername: 1, // Required for DA verification
          // We can return the full arrays or just counts/summaries.
          // Returning full arrays gives flexibility to frontend.
          domains: {
             $map: {
                input: "$domains",
                as: "d",
                in: {
                    domainName: "$$d.domainName",
                    status: "$$d.status",
                    expiryDate: "$$d.expiresAt",
                    createdAt: "$$d.createdAt"
                }
             }
          },
          hosting: {
            $map: {
                input: "$hosting",
                as: "h",
                in: {
                    domainName: "$$h.domainName", // Hosting is usually linked to a primary domain
                    status: "$$h.status",
                    expiryDate: "$$h.expiryDate",
                    createdAt: "$$h.createdAt",
                    name: "$$h.name" // Plan name
                }
             }
          }
        }
      },
      // Stage 5: Sort by most recent registration
      {
        $sort: { createdAt: -1 }
      }
    ]);

    // 3. Verify with DirectAdmin (Real-time check)
    // We only check users who have HOSTING. Pure domain users are verified by DB only (registrar check is too slow/complex for list view).
    
    // 3. Skip real-time DirectAdmin verification for list view to prevent timeouts.
    // relying on DB state is sufficient for this overview.
    let verifiedUsers = usersWithServices;

    // 4. Fallback: Include users who have a directAdminUsername but were missed by the aggregation 
    // (e.g., if they have no Hosting records but have a DA account)
    const allServiceUsers = await User.find({
      directAdminUsername: { $exists: true, $ne: null },
      isDeleted: { $ne: true }
    }).select('_id firstName lastName email role isActive createdAt directAdminUsername hostingCreatedAt hostingExpiresAt').lean();

    for (const u of allServiceUsers) {
      const alreadyInList = verifiedUsers.some((vu: any) => vu._id.toString() === u._id.toString());
      if (!alreadyInList) {
        // Construct a virtual hosting entry based on User fields
        verifiedUsers.push({
          ...u,
          domains: [], // We don't have domain list without Lookup, but we can show hosting
          hosting: [{
            domainName: "Pending Sync", // We don't store domain on User usually
            status: "active",
            expiryDate: (u as any).hostingExpiresAt,
            createdAt: (u as any).hostingCreatedAt,
            name: "Standard Hosting"
          }]
        });
      }
    }

    return NextResponse.json({
      success: true,
      users: verifiedUsers,
      count: verifiedUsers.length
    });
  } catch (error: any) {
    serverLogger.error('Error fetching service users:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch service users' },
      { status: 500 }
    );
  }
}