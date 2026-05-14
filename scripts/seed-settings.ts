/**
 * scripts/seed-settings.ts
 *
 * Ensures grace period settings exist in the Settings collection.
 * Safe to run multiple times — uses upsert so it won't overwrite existing values.
 *
 * Usage: npx ts-node -r tsconfig-paths/register scripts/seed-settings.ts
 *        Or call seedGracePeriodSettings() on app startup / deploy pipeline.
 */
import mongoose from "mongoose";
import Settings from "../models/Settings";

const SETTINGS_TO_SEED = [
  {
    key: "grace_period_enabled",
    value: false,
    description:
      "When true, services enter a grace period instead of immediate suspension on expiry.",
    category: "lifecycle",
  },
  {
    key: "grace_period_days",
    value: 3,
    description:
      "Number of days after expiry before a service in grace period becomes suspended.",
    category: "lifecycle",
  },
];

export async function seedGracePeriodSettings(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  let shouldDisconnect = false;
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(uri);
    shouldDisconnect = true;
  }

  for (const setting of SETTINGS_TO_SEED) {
    await Settings.findOneAndUpdate(
      { key: setting.key },
      {
        $setOnInsert: {
          // Only set value on first insert — don't overwrite admin changes
          key: setting.key,
          value: setting.value,
          description: setting.description,
          category: setting.category,
          updatedBy: "seed-script",
          updatedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );
    console.log(`[SeedSettings] Ensured setting: ${setting.key}`);
  }

  if (shouldDisconnect) {
    await mongoose.disconnect();
    console.log("[SeedSettings] Done.");
  }
}

// Run directly when executed as a script
if (require.main === module) {
  require("dotenv").config({ path: ".env.local" });
  seedGracePeriodSettings().catch((err) => {
    console.error("[SeedSettings] Error:", err);
    process.exit(1);
  });
}
