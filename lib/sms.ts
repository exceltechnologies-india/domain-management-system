/**
 * Minimal SMS sender abstraction.
 *
 * Wired but not yet integrated with a real carrier — the default `console`
 * provider just logs the OTP so dev/test environments don't accidentally
 * burn SMS credits. Swap in the MSG91 / Twilio adapter when ready.
 *
 * Carrier selection is env-driven:
 *   SMS_PROVIDER=console (default — log only)
 *   SMS_PROVIDER=msg91   (needs MSG91_AUTH_KEY, MSG91_SENDER_ID, MSG91_TEMPLATE_ID)
 */

import { serverLogger } from "@/lib/server-logger";

export interface SmsMessage {
  to: string; // E.164 or 10-digit Indian number
  template:
    | "trial_otp" // free-trial verification OTP
    | "generic"; // freeform
  variables: Record<string, string | number>;
  text?: string; // fallback freeform body for "generic"
}

export interface SmsResult {
  success: boolean;
  provider: string;
  messageId?: string;
  error?: string;
}

interface SmsProvider {
  name: string;
  send(msg: SmsMessage): Promise<SmsResult>;
}

const consoleProvider: SmsProvider = {
  name: "console",
  async send(msg) {
    serverLogger.info(
      `[SMS:console] to=${maskPhone(msg.to)} template=${msg.template} vars=${JSON.stringify(msg.variables)}`
    );
    return { success: true, provider: "console", messageId: `console_${Date.now()}` };
  },
};

const msg91Provider: SmsProvider = {
  name: "msg91",
  async send(msg) {
    const authKey = process.env.MSG91_AUTH_KEY;
    const templateId = process.env.MSG91_TEMPLATE_ID;
    if (!authKey || !templateId) {
      return {
        success: false,
        provider: "msg91",
        error: "MSG91 not configured (MSG91_AUTH_KEY / MSG91_TEMPLATE_ID missing)",
      };
    }

    const mobile = normalisePhoneForMsg91(msg.to);
    try {
      const res = await fetch("https://control.msg91.com/api/v5/flow", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authkey: authKey,
        },
        body: JSON.stringify({
          template_id: templateId,
          short_url: 0,
          recipients: [{ mobiles: mobile, ...msg.variables }],
        }),
      });
      const data = await res.json();
      if (!res.ok || data?.type === "error") {
        return {
          success: false,
          provider: "msg91",
          error: data?.message || `HTTP ${res.status}`,
        };
      }
      return {
        success: true,
        provider: "msg91",
        messageId: data?.request_id || data?.message,
      };
    } catch (err: any) {
      return {
        success: false,
        provider: "msg91",
        error: err?.message || "MSG91 request failed",
      };
    }
  },
};

function selectProvider(): SmsProvider {
  const choice = (process.env.SMS_PROVIDER || "console").toLowerCase();
  switch (choice) {
    case "msg91":
      return msg91Provider;
    case "console":
    default:
      return consoleProvider;
  }
}

function normalisePhoneForMsg91(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

function maskPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `***${digits.slice(-4)}`;
}

export async function sendSms(msg: SmsMessage): Promise<SmsResult> {
  return selectProvider().send(msg);
}
