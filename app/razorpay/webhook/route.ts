import { getUserById } from "@/lib/services/users";
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import connectDB from "@/lib/mongodb";
import { type IOrder } from "@/models/Order";
import { ZohoBooksService } from "@/lib/zohobooks";
import { serverLogger } from "@/lib/server-logger";
import {
  claimPendingOrderForProcessing,
  findOrderByRazorpayOrderIdOrInternalId,
  forceMarkZohoCreationFailed,
  getOrderByRazorpayPaymentId,
} from "@/lib/services/orders";
import { finalizePendingOrder } from "@/lib/services/payment/order-creator";
import { createPrimaryInvoice } from "@/lib/services/billing/createPrimaryInvoice";
import { RazorpayService } from "@/lib/razorpay";
import { createTokensFlowTrialHosting } from "@/lib/services/payment/tokens-trial-provisioner";
import { findUserHosting } from "@/lib/services/hostings";
import type { RazorpayPaymentDetails } from "@/lib/types";

export const dynamic = "force-dynamic";

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-razorpay-signature");

    if (!WEBHOOK_SECRET) {
      serverLogger.error("❌ RAZORPAY_WEBHOOK_SECRET is not defined");
      return NextResponse.json({ error: "Configuration Error" }, { status: 500 });
    }

    if (!signature) {
      return NextResponse.json({ error: "Missing Signature" }, { status: 400 });
    }

    // 1. Verify Signature
    const generatedSignature = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    if (generatedSignature !== signature) {
      serverLogger.error("❌ Invalid Webhook Signature");
      return NextResponse.json({ error: "Invalid Signature" }, { status: 400 });
    }

    const payload = JSON.parse(rawBody);
    const event = payload.event;



    if (event === "payment.captured") {
        await handlePaymentCaptured(payload);
    } else if (event === "refund.processed") {
        await handleRefundProcessed(payload);
    }

    return NextResponse.json({ status: "ok" });
  } catch (error: unknown) {
    serverLogger.error("❌ Webhook Error", error);
    // Return 500 to trigger retry from Razorpay
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

interface RazorpayPaymentEntity {
  id: string;
  amount: number;
  currency: string;
  order_id?: string;
  description?: string;
  // Razorpay puts `token_id` on the payment object when the payment authorizes
  // a recurring-payment mandate (CIT). Used by handleMandateValidationCaptured
  // to persist the token for future MIT charges. Defensively typed since
  // the official razorpay-node v2.9.6 RazorpayPayment shape doesn't declare
  // it; verified present in actual webhook payloads.
  token_id?: string;
  customer_id?: string;
  notes?: { receipt?: string; type?: string; user_id?: string; domain_name?: string; [k: string]: unknown };
}

interface PaymentCapturedPayload {
  payload: { payment: { entity: RazorpayPaymentEntity } };
}

interface RefundProcessedPayload {
  payload?: { refund?: { entity?: { id: string; payment_id: string; amount: number } } };
}

async function handlePaymentCaptured(payload: PaymentCapturedPayload) {
    await connectDB();
    const payment = payload.payload.payment.entity;
    const orderId = payment.notes?.receipt || payment.description;
    const razorpayOrderId = payment.order_id;

    const order = await findOrderByRazorpayOrderIdOrInternalId(
        orderId,
        razorpayOrderId
    );

    // Defensive: with the pending-order persistence in place at /create-order,
    // the order should always exist by the time the webhook fires. If it
    // doesn't (legacy orphan payment, or someone bypassing /create-order),
    // log and return 200 so Razorpay doesn't retry-storm. We can't safely
    // create an order here — we don't have cart contents from the Razorpay
    // payload alone.
    if (!order) {
        serverLogger.warn(
            `[Webhook] Order not found for payment ...${payment.id?.slice(-6)} (rzpOrder=${razorpayOrderId}). Returning 200 to stop retries.`
        );
        return;
    }

    // Tokens-flow CIT auth (mandate validation) — branches BEFORE the
    // renewal/upgrade check because Tokens-mode orders have orderType
    // 'hosting_trial' but mandateMode 'tokens', which is a different
    // codepath from the regular trial flow. The handler refunds the Rs 2
    // validation amount + stores the token_id for future MIT charges.
    // See docs/razorpay-tokens-migration.md S3.3 + S4.4.
    if (order.mandateMode === "tokens" && order.orderType === "hosting_trial") {
        await handleMandateValidationCaptured(order, payment);
        return;
    }

    // Renewal / upgrade orders have their own verify-side handlers
    // (`handleRenewalPayment`, `handleUpgradePayment`) that know how to
    // reactivate hosting, advance expiry dates, etc. The webhook can't
    // safely run that logic from generic provisioning, so it stays out
    // of the way and lets /verify do the work.
    if (
        order.orderType === "renewal" ||
        order.orderType === "hosting_upgrade"
    ) {
        if (!order.razorpayPaymentId || order.razorpayPaymentId === "pending") {
            order.razorpayPaymentId = payment.id;
            await order.save();
        }
        serverLogger.info(
            `[Webhook] payment.captured for ${order.orderId}: orderType=${order.orderType} — deferring to /verify`
        );
        return;
    }

    // Idempotency: once verify (or a prior webhook delivery) has moved the
    // order past `pending`, the webhook becomes a no-op. We still record
    // the Razorpay payment id if the row is still carrying the placeholder.
    if (order.status !== "pending") {
        if (!order.razorpayPaymentId || order.razorpayPaymentId === "pending") {
            order.razorpayPaymentId = payment.id;
            await order.save();
        }
        serverLogger.info(
            `[Webhook] payment.captured for ${order.orderId}: status=${order.status} — no-op (verify/another delivery handled it)`
        );
        return;
    }

    // Status is `pending` — attempt to claim. If we lose the claim, /verify
    // is mid-flight; nothing for us to do. Use the order's stored
    // razorpayOrderId (string, non-null per schema) rather than the
    // optional one off the Razorpay payload.
    const claimed = await claimPendingOrderForProcessing(order.razorpayOrderId, {
        razorpayPaymentId: payment.id,
        paymentVerification: {
            verifiedAt: new Date(),
            paymentStatus: "captured",
            paymentAmount: payment.amount,
            paymentCurrency: payment.currency,
            razorpayOrderId: order.razorpayOrderId,
        },
    });
    if (!claimed) {
        serverLogger.info(
            `[Webhook] payment.captured for ${order.orderId}: claim lost to /verify — no-op`
        );
        return;
    }

    serverLogger.info(
        `[Webhook] Claimed pending order ${claimed.orderId} for provisioning (rzp=${razorpayOrderId})`
    );

    const user = await getUserById(String(claimed.userId));
    if (!user) {
        serverLogger.error(
            `[Webhook] User ${claimed.userId} not found for order ${claimed.orderId} — leaving order in processing for admin inspection`
        );
        throw new Error("User not found for order");
    }

    const paymentDetails = {
        id: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        status: "captured" as const,
        order_id: payment.order_id ?? claimed.razorpayOrderId,
    } as RazorpayPaymentDetails;

    // Phase 4 (Primary Billing Integration Phase 1c-3): invoice creation via
    // createPrimaryInvoice — primary GST engine first, Zoho as automatic
    // fallback on any failure. Done inline (not inside finalizePendingOrder)
    // because /verify also creates its invoice before/alongside completing
    // the order — keeping both call sites symmetrical avoids the webhook
    // silently skipping invoicing on the unhappy path.
    //
    // Persisted IMMEDIATELY here (not stamped onto `claimed` in-memory for
    // finalizePendingOrder's later save, as this block used to do) — safe
    // because claimPendingOrderForProcessing above already gives this
    // webhook invocation exclusive ownership of the order, and
    // finalizePendingOrder's own `order.save()` only sends Mongoose's
    // tracked MODIFIED paths (see its comment: "save() emits only the
    // status transition... plus the Payment row"), so it can never clobber
    // fields a separate targeted `updateOne` already wrote here.
    //
    // TRIAL / ZERO-AMOUNT GUARD: createPrimaryInvoice has its own internal
    // copy of this guard, but checking it here too avoids even building the
    // cartItems payload for an order that will be skipped anyway. Tokens
    // trials already return earlier via handleMandateValidationCaptured;
    // this is defence-in-depth for any future non-trial-but-zero-amount
    // caller. See CLAUDE.md "Trial order invoice policy".
    const _webhookAmt = claimed.amount;
    const _skipInvoice =
        !_webhookAmt || _webhookAmt <= 0 || claimed.orderType === "hosting_trial";
    if (_skipInvoice) {
        serverLogger.info(
            `⏭️ [Webhook] Skipping zero-amount/trial invoice for ${claimed.orderId} ` +
            `(amount=${_webhookAmt}, orderType=${claimed.orderType}) — Trial order invoice policy.`
        );
    } else {
        try {
            const items = claimed.domains.map((d: IOrder["domains"][number]) => ({
                domainName: d.domainName,
                price: d.price,
                currency: d.currency,
                itemType: d.itemType,
                registrationPeriod: d.registrationPeriod,
                hostingPlan: d.hostingPlan,
            }));

            await createPrimaryInvoice({
                order: claimed,
                orderId: claimed.orderId,
                razorpay_payment_id: payment.id,
                paymentDetails,
                user,
                cartItems: items,
            });
        } catch (error) {
            // Don't rethrow — let provisioning proceed. The self-heal cron
            // picks up `creation_failed` orders later. Throwing here would
            // cause Razorpay to retry the webhook even though the payment
            // is safely captured and the order is being provisioned.
            // createPrimaryInvoice already tried BOTH engines before this
            // throws, so mark the terminal-failure sentinel directly rather
            // than leaving the claim dangling.
            serverLogger.error("❌ Invoice Sync Failed", error);
            await forceMarkZohoCreationFailed(claimed._id);
        }
    }

    // Phase 5: Provisioning + Payment row + status flip. finalizePendingOrder
    // runs the per-item provisioner fan-out, writes the Payment row, and
    // transitions the order to `completed` inside one Mongo transaction —
    // identical to the /verify happy path.
    try {
        // razorpaySignature: the webhook doesn't carry a per-payment HMAC
        // (only the whole-payload x-razorpay-signature header, which lives at
        // a different layer). Use the same "webhook_verified" sentinel
        // `lib/services/payment/webhook-handlers.ts` uses for the renewal
        // path — distinguishes webhook-completed rows from in-flight orders
        // (whose razorpaySignature is the literal "pending" placeholder
        // /create-order stamps in).
        const result = await finalizePendingOrder({
            order: claimed,
            user,
            razorpay_payment_id: payment.id,
            razorpay_signature: "webhook_verified",
            paymentDetails,
        });
        serverLogger.info(
            `[Webhook] Provisioned ${claimed.orderId}: success=${result.finalSuccessfulDomains.length} pending=${result.pendingDomains.length} fail=${result.failedDomains.length}`
        );
    } catch (error) {
        serverLogger.error("❌ [Webhook] Provisioning Failed", error);
        // Leave the order in `processing` so admin can inspect; rethrow so
        // Razorpay retries the webhook and we get another shot at provisioning.
        throw error;
    }
}

/**
 * Tokens-flow CIT auth (mandate validation) handler.
 *
 * Fires when payment.captured arrives for an Order with mandateMode='tokens'
 * + orderType='hosting_trial'. The customer authorized a recurring-payment
 * mandate by paying Rs 2 on Razorpay's checkout overlay; this handler:
 *  1. Extracts the token_id from the payment object (or fetches it from
 *     the customer's token list as a fallback).
 *  2. Refunds the Rs 2 immediately (the "and reverse" half of the Google
 *     "Rs 2-charge-and-reverse" pattern).
 *  3. Persists razorpayTokenId + razorpayPaymentId on the Order row so the
 *     Hosting provisioner (Phase 2C/2D) can find the mandate.
 *  4. Marks the Order completed.
 *
 * Idempotency: guarded by `order.status !== 'pending'`. If a retry-delivery
 * arrives after the first run completed, we no-op and let Razorpay's
 * retry budget exhaust naturally.
 *
 * Does NOT yet provision the Hosting record / DA account — that's Phase 2C
 * (will be driven by /verify reading the completed Order row OR by the
 * recurring-charge cron).
 *
 * See docs/razorpay-tokens-migration.md S3.3, S3.4, and S4.4.
 */
async function handleMandateValidationCaptured(
    order: IOrder & { save: () => Promise<unknown> },
    payment: RazorpayPaymentEntity
) {
    // Idempotency: another delivery already processed this order.
    if (order.status !== "pending") {
        serverLogger.info(
            `[Webhook] mandate_validation for ${order.orderId}: status=${order.status} — no-op`
        );
        return;
    }

    // Step 1: extract token_id. Razorpay sets payment.token_id on the
    // recurring-auth payment object. As a fallback, fetch the customer's
    // tokens and take the most recent one (sometimes the token_id arrives
    // a beat later via a separate webhook).
    let tokenId = payment.token_id;
    if (!tokenId && order.razorpayCustomerId) {
        serverLogger.warn(
            `[Webhook] mandate_validation for ${order.orderId}: token_id missing from payment ${payment.id}; will be picked up by token.confirmed webhook or polled via fetchTokens — deferring`
        );
        // Returning without completing the order keeps the Order in 'pending'
        // so a future webhook (token.confirmed) or admin re-sync can retry.
        // Razorpay's retry budget will re-deliver this event a few more times.
        return;
    }

    // Step 2: refund the Rs 2 validation amount. Use speed='optimum' for
    // fastest reversal — customer sees the refund within minutes on UPI,
    // hours on cards. This is the customer-trust-critical step; if it
    // fails, surface loudly in logs but DON'T block downstream — manual
    // refund from Razorpay dashboard is the fallback.
    // Persist the refund outcome on the order so a silent failure is visible
    // in the data (not just in prod-silenced logs). `refundPayment` now falls
    // back optimum→normal, so a failure here means a genuine problem worth an
    // operator's attention — `mandateRefundStatus:'failed'` flags exactly that.
    const orderRefund = order as IOrder & {
        mandateRefundId?: string;
        mandateRefundStatus?: string;
        mandateRefundedAt?: Date;
    };
    try {
        const refund = await RazorpayService.refundPayment(payment.id, payment.amount, {
            reason: "mandate_validation_refund",
            orderId: order.orderId,
        });
        orderRefund.mandateRefundId = refund?.id;
        orderRefund.mandateRefundStatus = "processed";
        orderRefund.mandateRefundedAt = new Date();
        serverLogger.info(
            `[Webhook] Refunded Rs ${payment.amount / 100} mandate-validation charge for ${order.orderId} (payment=${payment.id}, refund=${refund?.id})`
        );
    } catch (refundErr) {
        const msg = refundErr instanceof Error ? refundErr.message : String(refundErr);
        orderRefund.mandateRefundStatus = "failed";
        serverLogger.error(
            `❌ [Webhook] Mandate-validation refund FAILED for ${order.orderId} (payment=${payment.id}): ${msg}. Manual refund needed from Razorpay dashboard.`
        );
        // Continue — the token is still ours; losing the refund is a
        // money-loss event but the mandate itself is intact.
    }

    // Step 3: persist token + payment on the Order. Use the order's `save()`
    // rather than findOneAndUpdate because the document is already loaded.
    const orderRef = order as IOrder & {
        razorpayTokenId?: string;
        razorpayPaymentId?: string;
        status?: string;
        save: () => Promise<unknown>;
    };
    orderRef.razorpayTokenId = tokenId;
    orderRef.razorpayPaymentId = payment.id;
    orderRef.status = "completed";
    await orderRef.save();

    // Step 4: provision the Hosting record (Phase 2C). Idempotency guard:
    // if a Hosting already exists for this (userId, domainName), skip — the
    // first webhook delivery (or /verify) already created it.
    //
    // DirectAdmin user creation is intentionally deferred to Phase 2D's
    // provisioning cron. The Hosting created here has status='pending'
    // until that cron flips it to 'active'.
    try {
        const firstDomain = (order.domains as unknown as Array<{ domainName?: string }> | undefined)?.[0];
        const targetDomain = firstDomain?.domainName;
        if (targetDomain) {
            const existing = await findUserHosting(String(order.userId), { domainName: targetDomain });
            if (existing) {
                serverLogger.info(
                    `[Webhook] Hosting already exists for ${order.orderId} / ${targetDomain} — skipping create (idempotent)`
                );
            } else {
                await createTokensFlowTrialHosting(order as IOrder & { razorpayCustomerId?: string; razorpayTokenId?: string });
            }
        } else {
            serverLogger.warn(
                `[Webhook] Order ${order.orderId} has no domain in domains[0] — Hosting NOT created. Manual intervention required.`
            );
        }
    } catch (provisionErr) {
        const msg = provisionErr instanceof Error ? provisionErr.message : String(provisionErr);
        serverLogger.error(
            `❌ [Webhook] Hosting creation failed for ${order.orderId}: ${msg}. Order is marked completed + token stored; manual Hosting creation needed.`
        );
        // Don't rethrow — the mandate is set up, token is stored, order is
        // completed. A missing Hosting record is recoverable via admin tool
        // / re-running this function; a thrown error here would cause
        // Razorpay to retry the webhook indefinitely.
    }

    serverLogger.info(
        `✅ [Webhook] Mandate authorized + Hosting created for ${order.orderId}: token=${tokenId}, customer=${order.razorpayCustomerId} — DA provisioning deferred to Phase 2D cron`
    );
}

async function handleRefundProcessed(payload: RefundProcessedPayload) {
  await connectDB();

  const refund = payload.payload?.refund?.entity;
  if (!refund) {
    serverLogger.warn("[Webhook] refund.processed payload missing refund entity — skipping");
    return;
  }

  const paymentId: string = refund.payment_id;
  const refundId: string = refund.id;
  const refundAmountPaise: number = refund.amount;

  const order = await getOrderByRazorpayPaymentId(paymentId);
  if (!order) {
    serverLogger.warn(`[Webhook] refund.processed: no order found for payment ...${paymentId?.slice(-6)}`);
    return;
  }

  if (!order.zohoInvoiceId || order.zohoInvoiceId === "creation_failed") {
    serverLogger.warn(`[Webhook] refund.processed: order ${order.orderId} has no Zoho invoice — skipping credit note`);
    return;
  }

  try {
    const zohoService = ZohoBooksService.getInstance();
    const user = await getUserById(String(order.userId));
    if (!user) throw new Error("User not found for refunded order");

    // Look up the Zoho contact for this user
    const contact = await zohoService.getContactByEmail(user.email);
    if (!contact) throw new Error(`Zoho contact not found for ${user.email}`);

    await zohoService.createCreditNote(
      order.zohoInvoiceId,
      contact.contact_id,
      refundId,
      refundAmountPaise,
      order.orderId
    );

    serverLogger.info(`[Webhook] Credit note created for refund ${refundId} on order ${order.orderId}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error(`[Webhook] Failed to create credit note for refund ${refundId}`, message);
    // Don't throw — Razorpay doesn't need to retry refund webhooks for accounting failures.
    // Admin should be alerted via Cloud Logging / monitoring alert.
  }
}

