/**
 * Internal customer analytics: activity logging + configurable lead scoring.
 *
 * Score weights are stored in the Settings collection (key
 * `lead_score_weights`) merged over the defaults below, so marketing can
 * adjust them from the admin without a code change (SRS §7).
 *
 * Server-only.
 */

import mongoose from "mongoose";
import CustomerActivity, { type ActivityType } from "@/models/CustomerActivity";
import User from "@/models/User";
import { connectToDatabase } from "@/lib/mongoose";
import { getSettingValue, upsertSetting } from "@/lib/services/settings";
import { serverLogger } from "@/lib/server-logger";

export const LEAD_SCORE_WEIGHTS_KEY = "lead_score_weights";

/** Default weights (SRS §7). Configurable per-key via the admin. */
export const DEFAULT_SCORE_WEIGHTS: Record<ActivityType, number> = {
  landing_page_visit: 5,
  view_content: 5,
  start_trial: 10,
  registration: 20,
  email_verified: 30,
  first_login: 40,
  domain_added: 50,
  wordpress_installed: 70,
  website_uploaded: 90,
  checkout_started: 80,
  purchase: 100,
  renewal: 120,
};

export const ACTIVITY_TYPES = Object.keys(DEFAULT_SCORE_WEIGHTS) as ActivityType[];

/** Milestones that should only add score the first time per user. */
const ONCE_PER_USER: ReadonlySet<ActivityType> = new Set<ActivityType>([
  "registration",
  "email_verified",
  "first_login",
  "domain_added",
  "wordpress_installed",
  "website_uploaded",
]);

export async function getScoreWeights(): Promise<Record<ActivityType, number>> {
  const stored = await getSettingValue<Partial<Record<ActivityType, number>>>(
    LEAD_SCORE_WEIGHTS_KEY,
    {},
  );
  const merged = { ...DEFAULT_SCORE_WEIGHTS };
  if (stored && typeof stored === "object") {
    for (const k of ACTIVITY_TYPES) {
      const v = stored[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) merged[k] = v;
    }
  }
  return merged;
}

export async function setScoreWeights(
  weights: Partial<Record<ActivityType, number>>,
  updatedBy = "system",
): Promise<Record<ActivityType, number>> {
  const current = await getScoreWeights();
  const next = { ...current };
  for (const k of ACTIVITY_TYPES) {
    const v = weights[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) next[k] = Math.round(v);
  }
  await upsertSetting(LEAD_SCORE_WEIGHTS_KEY, next, {
    category: "analytics",
    description: "Lead-score weight per customer activity.",
    updatedBy,
  });
  return next;
}

interface RecordArgs {
  activity: ActivityType;
  userId?: string | mongoose.Types.ObjectId | null;
  anonId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Log a customer activity and update the user's lead score. Never throws to
 * the caller — analytics must not break the primary flow.
 */
export async function recordActivity({ activity, userId, anonId, metadata }: RecordArgs): Promise<void> {
  try {
    if (!ACTIVITY_TYPES.includes(activity)) return;
    await connectToDatabase();

    const weights = await getScoreWeights();
    let applyScore = weights[activity] ?? 0;

    const uid = userId ? new mongoose.Types.ObjectId(String(userId)) : null;

    if (uid && ONCE_PER_USER.has(activity)) {
      const already = await CustomerActivity.exists({ userId: uid, activity });
      if (already) applyScore = 0;
    }

    await CustomerActivity.create({
      userId: uid,
      anonId: anonId ?? null,
      activity,
      score: applyScore,
      metadata,
    });

    if (uid) {
      const update: Record<string, unknown> = { $set: { lastActivityAt: new Date() } };
      if (applyScore) update.$inc = { leadScore: applyScore };
      await User.updateOne({ _id: uid }, update);
    }
  } catch (error) {
    serverLogger.error(`[analytics] recordActivity(${activity}) failed`, error);
  }
}
