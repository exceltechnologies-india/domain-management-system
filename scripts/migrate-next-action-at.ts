/**
 * One-time migration: update next_action_at for existing active hostings.
 *
 * Before this change, next_action_at was either unset (never picked up by the
 * daily scheduler) or set to expiryDate - 7 days (old reminder window).
 * This script shifts it to expiryDate - 15 days so all active hostings get
 * the new 15-day first reminder.
 *
 * Only touches hostings with more than 15 days remaining — those already inside
 * the window are left alone so their existing schedule is not disrupted.
 *
 * Run once after deploying the 15-day reminder changes:
 *   npx ts-node scripts/migrate-next-action-at.ts
 */

import connectDB from "../lib/mongodb";
import Hosting from "../models/Hosting";
// Suppress Next.js-specific env checks that don't apply in script context
process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL || "http://localhost:3000";

async function migrate() {
  await connectDB();

  const now = new Date();
  const fifteenDaysFromNow = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000);

  // Find active hostings that still have more than 15 days left AND whose
  // next_action_at is either missing or set later than expiryDate - 15 days
  // (i.e., the old 7-day checkpoint or no checkpoint at all).
  const result = await Hosting.updateMany(
    {
      status: "active",
      expiryDate: { $gt: fifteenDaysFromNow },
      $or: [
        { next_action_at: { $exists: false } },
        { next_action_at: null },
        { next_action_at: { $gt: fifteenDaysFromNow } },
      ],
    },
    [
      {
        $set: {
          next_action_at: {
            $subtract: ["$expiryDate", 15 * 24 * 60 * 60 * 1000],
          },
        },
      },
    ]
  );

  console.log(
    `Migration complete. Updated ${result.modifiedCount} hosting records.`
  );
  process.exit(0);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
