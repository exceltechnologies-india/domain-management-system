/**
 * Reseller service (sub-reseller feature — Model A, Phase 1).
 *
 * Encapsulates all Reseller collection access behind named helpers so routes
 * don't touch the model directly. Every reseller-scoped read MUST filter by the
 * owning tenant (the hard rule from the design: a reseller can never see another
 * tenant's data) — Phase 1 only exposes admin-scoped operations, but the
 * owner-scoped reader `getResellerByOwnerUserId` is the seam the Phase-2 panel
 * will build on.
 *
 * Account creation reuses the same set-password path as guest checkout
 * (create User with a random password + reset token → email a setup link via
 * `EmailService.sendPasswordResetEmail(..., isSetup=true)`), so the reseller
 * chooses their own password on first login.
 */
import { randomBytes } from "crypto";
import connectDB from "@/lib/mongodb";
import User from "@/models/User";
import Reseller from "@/models/Reseller";
import type { IReseller } from "@/models/Reseller";
import { EmailService } from "@/lib/email";
import { serverLogger } from "@/lib/server-logger";

export class ResellerError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = "ResellerError";
    this.code = code;
    this.status = status;
  }
}

/** URL-safe unique handle from a business name (append a short suffix on collision). */
async function makeUniqueSlug(businessName: string): Promise<string> {
  const base =
    businessName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "reseller";
  let slug = base;
  // Very small collision space in practice; cap attempts defensively.
  for (let i = 0; i < 5; i++) {
    const existing = await Reseller.exists({ slug });
    if (!existing) return slug;
    slug = `${base}-${randomBytes(2).toString("hex")}`;
  }
  return `${base}-${randomBytes(4).toString("hex")}`;
}

// ─── Writes (admin-scoped) ──────────────────────────────────────────────────

export interface CreateResellerInput {
  email: string;
  businessName: string;
  markupPercent?: number;
}

/**
 * Admin creates a fresh reseller: a new login User (role stays "user" until
 * approval) + a pending Reseller profile, then emails a set-password link.
 * Rejects if a user already exists for that email.
 */
export async function createReseller(
  input: CreateResellerInput,
  adminId: string
): Promise<IReseller> {
  await connectDB();
  const email = input.email.toLowerCase().trim();
  const businessName = input.businessName.trim();

  const existing = await User.findOne({ email }).select("_id");
  if (existing) {
    throw new ResellerError(
      "A user with that email already exists.",
      "EMAIL_IN_USE",
      409
    );
  }

  // Random password the reseller never uses — they set their own via the setup
  // email. The pre-save hook bcrypts it. Account is pre-activated (admin-created,
  // trusted) so they can sign in immediately after setting a password.
  const setupToken = randomBytes(32).toString("hex");
  const user = await User.create({
    email,
    password: randomBytes(24).toString("hex"),
    firstName: businessName,
    lastName: "(Reseller)",
    role: "user",
    provider: "credentials",
    isActivated: true,
    profileCompleted: false,
    resetToken: setupToken,
    resetTokenExpiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
  });

  const slug = await makeUniqueSlug(businessName);
  const reseller = await Reseller.create({
    ownerUserId: user._id,
    businessName,
    slug,
    status: "pending",
    ...(typeof input.markupPercent === "number"
      ? { markupPercent: input.markupPercent }
      : {}),
  });

  // Fire-and-forget setup email (never block creation on mail delivery).
  EmailService.sendPasswordResetEmail(email, businessName, setupToken, true).catch(
    (err) => serverLogger.error("[resellers] setup email failed:", err)
  );

  serverLogger.info(
    `[resellers] created reseller ${reseller._id} (${businessName}) by admin ${adminId}`
  );
  return reseller;
}

/** Approve a pending reseller: activate status + flip the owner's role to "reseller". */
export async function approveReseller(
  resellerId: string,
  adminId: string
): Promise<IReseller> {
  await connectDB();
  const reseller = await Reseller.findById(resellerId);
  if (!reseller) throw new ResellerError("Reseller not found.", "NOT_FOUND", 404);

  reseller.status = "approved";
  reseller.approvedAt = new Date();
  reseller.approvedBy = adminId as unknown as IReseller["approvedBy"];
  await reseller.save();

  await User.updateOne({ _id: reseller.ownerUserId }, { $set: { role: "reseller" } });
  serverLogger.info(`[resellers] approved ${resellerId} by admin ${adminId}`);
  return reseller;
}

/** Suspend a reseller (status only; the owner keeps role "reseller"). */
export async function suspendReseller(resellerId: string): Promise<IReseller> {
  await connectDB();
  const reseller = await Reseller.findById(resellerId);
  if (!reseller) throw new ResellerError("Reseller not found.", "NOT_FOUND", 404);
  reseller.status = "suspended";
  await reseller.save();
  return reseller;
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** Admin list — newest first, with the owner's email/name populated. */
export async function listResellers() {
  await connectDB();
  return Reseller.find({})
    .sort({ createdAt: -1 })
    .populate("ownerUserId", "email firstName lastName role")
    .lean();
}

export async function getResellerById(resellerId: string) {
  await connectDB();
  return Reseller.findById(resellerId)
    .populate("ownerUserId", "email firstName lastName role")
    .lean();
}

/**
 * Owner-scoped read — the seam the Phase-2 reseller panel builds on. Returns the
 * tenant for a given login user, or null. Never accepts another tenant's id.
 */
export async function getResellerByOwnerUserId(userId: string) {
  await connectDB();
  return Reseller.findOne({ ownerUserId: userId }).lean();
}
