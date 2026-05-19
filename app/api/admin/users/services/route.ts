export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';

import { getServerSession } from 'next-auth';
import {
  listServiceUserCandidates,
  listUsersWithServicesAggregation,
  type UserWithServices,
} from '@/lib/services/users';
import { authOptions } from '@/lib/auth-config';
import { serverLogger } from '@/lib/server-logger';

export async function GET(request: Request) {
  try {
    // 1. Check Authentication & Admin Role
    const session = await getServerSession(authOptions);

    const sessionUser = session?.user as { role?: string } | undefined;
    if (!session || !session.user || sessionUser?.role !== 'admin') {
      return NextResponse.json(
        { error: 'Unauthorized access' },
        { status: 401 }
      );
    }

    // 2. Aggregation pipeline (every user that owns at least one Domain or
    //    Hosting). The pipeline itself lives in the User service.
    const usersWithServices = await listUsersWithServicesAggregation();

    // 3. Skip real-time DirectAdmin verification for list view to prevent timeouts.
    //    Relying on DB state is sufficient for this overview.
    const verifiedUsers: UserWithServices[] = usersWithServices;

    // 4. Fallback: Include users who have a directAdminUsername but were missed
    //    by the aggregation (e.g., if they have no Hosting records but have a
    //    DA account).
    const allServiceUsers = await listServiceUserCandidates();

    for (const u of allServiceUsers) {
      const alreadyInList = verifiedUsers.some(
        (vu) => vu._id.toString() === String(u._id)
      );
      if (!alreadyInList) {
        // Construct a virtual hosting entry based on User fields
        verifiedUsers.push({
          _id: u._id as { toString(): string },
          firstName: u.firstName,
          lastName: u.lastName,
          email: u.email,
          role: u.role,
          isActive: u.isActive,
          createdAt: u.createdAt,
          directAdminUsername: u.directAdminUsername,
          domains: [], // We don't have domain list without Lookup, but we can show hosting
          hosting: [{
            domainName: "Pending Sync", // We don't store domain on User usually
            status: "active",
            expiryDate: u.hostingExpiresAt,
            createdAt: u.hostingCreatedAt,
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
  } catch (error: unknown) {
    serverLogger.error('Error fetching service users:', error);
    const message = error instanceof Error ? error.message : 'Failed to fetch service users';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}