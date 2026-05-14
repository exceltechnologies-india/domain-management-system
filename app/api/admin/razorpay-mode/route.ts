import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getToken } from "next-auth/jwt";
import { AUTH_SECRET } from "@/lib/auth-secret";
import Settings from "@/models/Settings";
import User from "@/models/User";
import { connectToDatabase } from "@/lib/mongoose";
import { serverLogger } from "@/lib/server-logger";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

export const dynamic = "force-dynamic";

async function getAdminUser(request: NextRequest) {
  let user = await AuthService.getUserFromRequest(request);
  if (!user) {
    const token = await getToken({ req: request, secret: AUTH_SECRET });
    if (token?.id) {
      user = await User.findById(token.id).select("-password");
    }
  }
  if (!user || user.role !== "admin") return null;
  return user;
}

function readEnvFile(): Record<string, string> {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return {};
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  const env: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return env;
}

function writeEnvFile(env: Record<string, string>): void {
  const envPath = path.join(process.cwd(), ".env.local");
  const existingRaw = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf-8")
    : "";

  // Preserve comments and ordering of existing file; update/append keys
  const lines = existingRaw.split("\n");
  const written = new Set<string>();

  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) return line;
    const key = trimmed.slice(0, eqIdx);
    if (key in env) {
      written.add(key);
      return `${key}=${env[key]}`;
    }
    return line;
  });

  // Append any new keys not already in file
  for (const [key, value] of Object.entries(env)) {
    if (!written.has(key)) {
      updatedLines.push(`${key}=${value}`);
    }
  }

  fs.writeFileSync(envPath, updatedLines.join("\n"), "utf-8");
}

// GET — return current mode + stored key metadata (no secrets exposed)
export async function GET(request: NextRequest) {
  try {
    await connectToDatabase();
    const user = await getAdminUser(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const env = readEnvFile();
    const currentKeyId = env["RAZORPAY_KEY_ID"] || process.env.RAZORPAY_KEY_ID || "";
    const mode = currentKeyId.startsWith("rzp_live_") ? "live" : "test";

    const [testKeyIdSetting, liveKeyIdSetting] = await Promise.all([
      Settings.findOne({ key: "razorpay_test_key_id" }),
      Settings.findOne({ key: "razorpay_live_key_id" }),
    ]);

    return NextResponse.json({
      success: true,
      mode,
      currentKeyId,
      hasTestKeys: !!(testKeyIdSetting?.value && (await Settings.findOne({ key: "razorpay_test_key_secret" }))?.value),
      hasLiveKeys: !!(liveKeyIdSetting?.value && (await Settings.findOne({ key: "razorpay_live_key_secret" }))?.value),
      testKeyId: testKeyIdSetting?.value || "",
      liveKeyId: liveKeyIdSetting?.value || "",
    });
  } catch (error) {
    serverLogger.error("razorpay-mode GET error", { error });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST — save keys and/or switch mode
export async function POST(request: NextRequest) {
  try {
    await connectToDatabase();
    const user = await getAdminUser(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { action, mode, testKeyId, testKeySecret, liveKeyId, liveKeySecret, webhookSecret } = body;

    if (action === "save_keys") {
      // Persist keys to Settings (secrets stored encrypted-at-rest via MongoDB)
      const updates = [];
      if (testKeyId !== undefined) {
        updates.push(Settings.findOneAndUpdate(
          { key: "razorpay_test_key_id" },
          { key: "razorpay_test_key_id", value: testKeyId, category: "payment", description: "Razorpay test mode key ID" },
          { upsert: true, new: true }
        ));
      }
      if (testKeySecret !== undefined) {
        updates.push(Settings.findOneAndUpdate(
          { key: "razorpay_test_key_secret" },
          { key: "razorpay_test_key_secret", value: testKeySecret, category: "payment", description: "Razorpay test mode key secret" },
          { upsert: true, new: true }
        ));
      }
      if (liveKeyId !== undefined) {
        updates.push(Settings.findOneAndUpdate(
          { key: "razorpay_live_key_id" },
          { key: "razorpay_live_key_id", value: liveKeyId, category: "payment", description: "Razorpay live mode key ID" },
          { upsert: true, new: true }
        ));
      }
      if (liveKeySecret !== undefined) {
        updates.push(Settings.findOneAndUpdate(
          { key: "razorpay_live_key_secret" },
          { key: "razorpay_live_key_secret", value: liveKeySecret, category: "payment", description: "Razorpay live mode key secret" },
          { upsert: true, new: true }
        ));
      }
      if (webhookSecret !== undefined) {
        updates.push(Settings.findOneAndUpdate(
          { key: "razorpay_webhook_secret" },
          { key: "razorpay_webhook_secret", value: webhookSecret, category: "payment", description: "Razorpay webhook secret (shared between test and live)" },
          { upsert: true, new: true }
        ));
      }
      await Promise.all(updates);
      serverLogger.info("Razorpay keys saved", { adminId: user._id, savedFields: Object.keys(body).filter(k => k !== 'action') });
      return NextResponse.json({ success: true, message: "Keys saved successfully" });
    }

    if (action === "switch_mode") {
      if (!["test", "live"].includes(mode)) {
        return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
      }

      const keyIdKey = mode === "live" ? "razorpay_live_key_id" : "razorpay_test_key_id";
      const keySecretKey = mode === "live" ? "razorpay_live_key_secret" : "razorpay_test_key_secret";
      const webhookSecretSetting = await Settings.findOne({ key: "razorpay_webhook_secret" });

      const keyIdSetting = await Settings.findOne({ key: keyIdKey });
      const keySecretSetting = await Settings.findOne({ key: keySecretKey });

      if (!keyIdSetting?.value || !keySecretSetting?.value) {
        return NextResponse.json(
          { error: `No ${mode} mode keys found. Please save ${mode} keys first.` },
          { status: 400 }
        );
      }

      // Update .env.local
      const envUpdates: Record<string, string> = {
        RAZORPAY_KEY_ID: keyIdSetting.value,
        RAZORPAY_KEY_SECRET: keySecretSetting.value,
        NEXT_PUBLIC_RAZORPAY_KEY_ID: keyIdSetting.value,
      };
      if (webhookSecretSetting?.value) {
        envUpdates.RAZORPAY_WEBHOOK_SECRET = webhookSecretSetting.value;
      }
      writeEnvFile(envUpdates);

      // Restart PM2 app (non-blocking — fire and forget)
      try {
        execSync("pm2 restart next-app --update-env 2>&1 || true", { timeout: 10000 });
      } catch (e) {
        // PM2 may not be running in dev mode — log but don't fail
        serverLogger.warn("PM2 restart skipped (not running or not available)", { error: String(e) });
      }

      serverLogger.info("Razorpay mode switched", { adminId: user._id, mode });
      return NextResponse.json({
        success: true,
        message: `Switched to ${mode} mode. Server is restarting — this may take a few seconds.`,
        mode,
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    serverLogger.error("razorpay-mode POST error", { error });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
