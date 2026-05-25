import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getSettingsMap, upsertSetting } from "@/lib/services/settings";
import { connectToDatabase } from "@/lib/mongoose";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// Discriminated union — the body shape is action-dependent.
const razorpayModeSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save_keys"),
    testKeyId: z.string().optional(),
    testKeySecret: z.string().optional(),
    liveKeyId: z.string().optional(),
    liveKeySecret: z.string().optional(),
    webhookSecret: z.string().optional(),
  }),
  z.object({
    action: z.literal("switch_mode"),
    mode: z.enum(["test", "live"]),
  }),
]);

export const dynamic = "force-dynamic";

const getAdminUser = (request: NextRequest) =>
  AuthService.getAdminFromRequest(request);

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

    const keys = await getSettingsMap([
      "razorpay_test_key_id",
      "razorpay_test_key_secret",
      "razorpay_live_key_id",
      "razorpay_live_key_secret",
    ]);

    return NextResponse.json({
      success: true,
      mode,
      currentKeyId,
      hasTestKeys: !!(keys.razorpay_test_key_id && keys.razorpay_test_key_secret),
      hasLiveKeys: !!(keys.razorpay_live_key_id && keys.razorpay_live_key_secret),
      testKeyId: keys.razorpay_test_key_id || "",
      liveKeyId: keys.razorpay_live_key_id || "",
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

    const validation = await validatedBody(request, razorpayModeSchema);
    if (!validation.ok) return validation.response;
    const body = validation.data;

    if (body.action === "save_keys") {
      const { testKeyId, testKeySecret, liveKeyId, liveKeySecret, webhookSecret } = body;
      // Persist keys to Settings (secrets stored encrypted-at-rest via MongoDB)
      const updates: Promise<void>[] = [];
      const opts = { category: "payment", updatedBy: String(user._id) };
      if (testKeyId !== undefined) {
        updates.push(upsertSetting("razorpay_test_key_id", testKeyId, { ...opts, description: "Razorpay test mode key ID" }));
      }
      if (testKeySecret !== undefined) {
        updates.push(upsertSetting("razorpay_test_key_secret", testKeySecret, { ...opts, description: "Razorpay test mode key secret" }));
      }
      if (liveKeyId !== undefined) {
        updates.push(upsertSetting("razorpay_live_key_id", liveKeyId, { ...opts, description: "Razorpay live mode key ID" }));
      }
      if (liveKeySecret !== undefined) {
        updates.push(upsertSetting("razorpay_live_key_secret", liveKeySecret, { ...opts, description: "Razorpay live mode key secret" }));
      }
      if (webhookSecret !== undefined) {
        updates.push(upsertSetting("razorpay_webhook_secret", webhookSecret, { ...opts, description: "Razorpay webhook secret (shared between test and live)" }));
      }
      await Promise.all(updates);
      const savedFields = Object.keys(body).filter((k) => k !== "action");
      serverLogger.info("Razorpay keys saved", { adminId: user._id, savedFields });
      return NextResponse.json({ success: true, message: "Keys saved successfully" });
    }

    if (body.action === "switch_mode") {
      const { mode } = body;
      const keyIdKey = mode === "live" ? "razorpay_live_key_id" : "razorpay_test_key_id";
      const keySecretKey = mode === "live" ? "razorpay_live_key_secret" : "razorpay_test_key_secret";

      const keyMap = await getSettingsMap([keyIdKey, keySecretKey, "razorpay_webhook_secret"]);
      const storedKeyId = keyMap[keyIdKey] as string | undefined;
      const storedKeySecret = keyMap[keySecretKey] as string | undefined;
      const storedWebhookSecret = keyMap.razorpay_webhook_secret as string | undefined;

      if (!storedKeyId || !storedKeySecret) {
        return NextResponse.json(
          { error: `No ${mode} mode keys found. Please save ${mode} keys first.` },
          { status: 400 }
        );
      }

      // Update .env.local
      const envUpdates: Record<string, string> = {
        RAZORPAY_KEY_ID: storedKeyId,
        RAZORPAY_KEY_SECRET: storedKeySecret,
        NEXT_PUBLIC_RAZORPAY_KEY_ID: storedKeyId,
      };
      if (storedWebhookSecret) {
        envUpdates.RAZORPAY_WEBHOOK_SECRET = storedWebhookSecret;
      }
      writeEnvFile(envUpdates);

      // Signal the standalone server to exit so the host's process supervisor
      // (systemd on VPS, Cloud Run on managed hosting) restarts it with the
      // new .env.local values. We read the PID written by deploy.sh and send
      // SIGTERM — the server will drain in-flight requests, then exit, then
      // the supervisor re-spawns it.
      //
      // If no supervisor is set up, the server stays down after this signal
      // and an operator must re-run deploy.sh. That's a known limitation of
      // PM2-less VPS deploys; the admin response makes the contract explicit.
      let restartTriggered = false;
      try {
        const pidPath = path.join(process.cwd(), "deployment-logs", ".server.pid");
        const pidRaw = fs.readFileSync(pidPath, "utf8").trim();
        const pid = parseInt(pidRaw, 10);
        if (Number.isFinite(pid) && pid > 0) {
          // Use shell `kill` rather than process.kill so we don't accidentally
          // signal *this* process (which is also the server) before the
          // response has flushed. Fire-and-forget.
          execSync(`kill -TERM ${pid} 2>/dev/null || true`, { timeout: 2000 });
          restartTriggered = true;
        }
      } catch (e) {
        serverLogger.warn(
          "Razorpay mode: could not signal server for restart — env change saved but takes effect on next deploy",
          { error: String(e) }
        );
      }

      serverLogger.info("Razorpay mode switched", { adminId: user._id, mode, restartTriggered });
      return NextResponse.json({
        success: true,
        message: restartTriggered
          ? `Switched to ${mode} mode. Server is restarting — this may take a few seconds.`
          : `Switched to ${mode} mode. New keys saved to .env.local but server was not restarted — re-deploy to apply.`,
        mode,
        restartTriggered,
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    serverLogger.error("razorpay-mode POST error", { error });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
