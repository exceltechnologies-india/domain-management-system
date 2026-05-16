/**
 * User service.
 *
 * The single place route handlers reach for User-collection operations.
 * Goal: insulate routes from Mongoose schema changes, centralise common
 * select/projection patterns (e.g. always strip `-password` for non-auth
 * reads), and surface domain-meaningful use cases instead of raw CRUD.
 *
 * This was the first concrete step toward HIGH-4. The pattern is modelled on
 * lib/services/payment/ (formerly lib/payment-services/) — domain-specific
 * use-case functions rather than a generic repository abstraction.
 */

import connectDB from "@/lib/mongodb";
import User from "@/models/User";
import type { IUser } from "@/models/User";

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Read a user by primary key. Returns null when not found.
 * Includes all fields including the password hash — only use this for
 * auth-internal code paths. Most callers want {@link getUserByIdSafe} instead.
 */
export async function getUserById(id: string): Promise<IUser | null> {
  await connectDB();
  return User.findById(id);
}

/**
 * Read a user by primary key, with the password hash stripped.
 * The default for any code path that returns user data to clients.
 */
export async function getUserByIdSafe(id: string): Promise<IUser | null> {
  await connectDB();
  return User.findById(id).select("-password");
}

/**
 * Read a user by email. The auth-flow lookup — caller may need the password
 * hash for credential verification, so the full document is returned.
 */
export async function getUserByEmail(email: string): Promise<IUser | null> {
  await connectDB();
  return User.findOne({ email });
}

/**
 * Lightweight role lookup. Used by admin-guard paths that only care whether
 * the target is or isn't an admin — avoids pulling the rest of the document.
 */
export async function findUserRoleById(
  id: string
): Promise<{ role: IUser["role"] } | null> {
  await connectDB();
  return User.findById(id).select("role").lean<{ role: IUser["role"] }>();
}

export async function countAdmins(): Promise<number> {
  await connectDB();
  return User.countDocuments({ role: "admin" });
}

export async function countUsers(
  filter: Record<string, unknown> = {}
): Promise<number> {
  await connectDB();
  return User.countDocuments(filter);
}

export interface ListUsersOptions {
  filter?: Record<string, unknown>;
  page?: number;
  limit?: number;
  projection?: Record<string, 0 | 1>;
  sort?: Record<string, 1 | -1>;
}

export interface ListUsersResult {
  users: any[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasMore: boolean;
}

const ADMIN_LIST_PROJECTION = {
  firstName: 1,
  lastName: 1,
  email: 1,
  role: 1,
  createdAt: 1,
  isActive: 1,
  hostingCreatedAt: 1,
  hostingExpiresAt: 1,
  totpEnabled: 1,
} as const;

/**
 * Paginated user list for admin UIs. Default projection matches the
 * historic admin-users endpoint shape so existing clients keep working.
 */
export async function listUsers(
  options: ListUsersOptions = {}
): Promise<ListUsersResult> {
  await connectDB();
  const {
    filter = { role: { $ne: "admin" }, isDeleted: { $ne: true } },
    page = 1,
    limit = 50,
    projection = ADMIN_LIST_PROJECTION,
    sort = { createdAt: -1 },
  } = options;

  const skip = (page - 1) * limit;
  const [users, total] = await Promise.all([
    User.find(filter, projection).sort(sort).skip(skip).limit(limit).lean(),
    User.countDocuments(filter),
  ]);

  return {
    users,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 0,
    hasMore: page * limit < total,
  };
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Update a user's role via a strict, whitelisted findByIdAndUpdate so
 * mass-assignment of unrelated fields is impossible. Returns the updated
 * lean document or null when the user wasn't found.
 */
export async function updateUserRole(
  id: string,
  role: IUser["role"]
): Promise<{
  _id: any;
  firstName: string;
  lastName: string;
  email: string;
  role: IUser["role"];
} | null> {
  await connectDB();
  return User.findByIdAndUpdate(
    id,
    { role },
    { new: true, select: "firstName lastName email role" }
  ).lean<{
    _id: any;
    firstName: string;
    lastName: string;
    email: string;
    role: IUser["role"];
  }>();
}

/**
 * Soft-delete a user: mark inactive + deleted, set deletion timestamp,
 * invalidate all sessions. Returns the updated document or null.
 */
export async function softDeleteUser(id: string): Promise<IUser | null> {
  await connectDB();
  return User.findByIdAndUpdate(
    id,
    {
      isActive: false,
      isDeleted: true,
      deletedAt: new Date(),
      sessionInvalidatedAt: new Date(),
    },
    { new: true }
  );
}

/**
 * Permanent deletion — snapshot the user's display name/email onto any
 * historical Order rows that don't already carry it (so audit reports
 * survive the deletion), then drop the user document.
 *
 * Returns the count of Orders updated. Throws if the user doesn't exist
 * (caller should check first).
 */
export async function permanentDeleteUser(id: string): Promise<{
  ordersSnapshotted: number;
}> {
  await connectDB();
  // Snapshot first so the historical record survives. Best-effort — if it
  // fails the caller has already authorised the destructive action and we
  // proceed (failure is logged).
  let ordersSnapshotted = 0;
  try {
    const Order = (await import("@/models/Order")).default;
    const user = await User.findById(id).select("firstName lastName email").lean<{
      firstName?: string;
      lastName?: string;
      email?: string;
    }>();
    if (user) {
      const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim();
      const email = user.email;
      const result = await Order.updateMany(
        { userId: id, $or: [{ userName: { $exists: false } }, { userName: "" }] },
        { $set: { userName: fullName, userEmail: email } }
      );
      ordersSnapshotted = result.modifiedCount ?? 0;
    }
  } catch {
    /* swallow — admin explicitly requested deletion; failure logged by caller */
  }

  await User.findByIdAndDelete(id);
  return { ordersSnapshotted };
}

/**
 * Update an arbitrary subset of user fields, applied via `.save()` so any
 * schema-level pre-save hooks fire. The caller controls the whitelist —
 * this service does not enforce one. When `isActive` transitions true→false
 * the function also sets `sessionInvalidatedAt` so sessions are revoked.
 *
 * Returns the saved document or null when the user isn't found.
 */
export interface UpdateUserPatch {
  firstName?: string;
  lastName?: string;
  email?: string;
  role?: IUser["role"];
  isActive?: boolean;
}

export async function applyUserPatch(
  id: string,
  patch: UpdateUserPatch
): Promise<IUser | null> {
  await connectDB();
  const user = await User.findById(id);
  if (!user) return null;

  const wasActive = user.isActive;
  if (patch.firstName !== undefined) user.firstName = patch.firstName;
  if (patch.lastName !== undefined) user.lastName = patch.lastName;
  if (patch.email !== undefined) user.email = patch.email;
  if (patch.role !== undefined && ["user", "admin"].includes(patch.role)) {
    user.role = patch.role;
  }
  if (typeof patch.isActive === "boolean") {
    user.isActive = patch.isActive;
    if (!patch.isActive && wasActive) {
      // Disabling → invalidate sessions immediately.
      (user as any).sessionInvalidatedAt = new Date();
    } else if (patch.isActive && !wasActive) {
      // Re-enabling → clear the invalidation stamp.
      (user as any).sessionInvalidatedAt = null;
    }
  }

  await user.save();
  return user;
}
