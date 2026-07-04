/**
 * WhatsApp message delivery-audit writes.
 *
 * Both functions are strictly best-effort + no-throw: they run off the
 * WhatsApp send hot path + the webhook handler, neither of which should
 * fail because an audit write hiccuped.
 */
import connectDB from "@/lib/mongodb";
import WhatsAppMessageLog from "@/models/WhatsAppMessageLog";
import { serverLogger } from "@/lib/server-logger";

/** Record an outbound send (called after Meta returns a wamid). */
export async function recordWhatsAppSend(args: {
  messageId: string;
  to: string;
  template?: string;
}): Promise<void> {
  try {
    await connectDB();
    await WhatsAppMessageLog.create({
      messageId: args.messageId,
      to: args.to,
      template: args.template,
      status: "sent",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (e) {
    serverLogger.warn(
      `[whatsapp-log] recordWhatsAppSend failed for ${args.messageId}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * Update a logged message's delivery status from a webhook callback.
 * Matched on the Meta message id. No-op if the row doesn't exist (e.g.
 * the send predated this feature) — we don't back-fill.
 */
export async function updateWhatsAppStatus(args: {
  messageId: string;
  status: "delivered" | "read" | "failed";
  error?: string;
}): Promise<void> {
  try {
    await connectDB();
    await WhatsAppMessageLog.updateOne(
      { messageId: args.messageId },
      {
        $set: {
          status: args.status,
          ...(args.error ? { error: args.error } : {}),
          updatedAt: new Date(),
        },
      }
    );
  } catch (e) {
    serverLogger.warn(
      `[whatsapp-log] updateWhatsAppStatus failed for ${args.messageId}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
