/**
 * Zoho Books credit note operations.
 */

import { zohoAxios } from './axios-client';
import { serverLogger } from '../server-logger';
import type { ZohoBooksService } from '../zohobooks';
import { ZohoError } from '../zohobooks';
import type { ZohoCreditNote } from './types';

/**
 * Create a credit note in Zoho Books for a Razorpay refund, then apply it to
 * the original invoice so the accounting records stay in sync.
 *
 * @param zohoInvoiceId - The Zoho invoice ID stored on the Order document
 * @param zohoContactId - The Zoho contact ID for the customer
 * @param refundId      - Razorpay refund ID (rfnd_...)
 * @param refundAmountPaise - Refund amount in paise (Razorpay native unit)
 * @param orderId       - Internal order ID for the reference number
 * @returns The created credit note object, or throws on failure
 */
export async function createCreditNote(
  self: ZohoBooksService,
  zohoInvoiceId: string,
  zohoContactId: string,
  refundId: string,
  refundAmountPaise: number,
  orderId: string
): Promise<ZohoCreditNote> {
  if (!self._hasRefreshToken()) {
    throw new ZohoError('Config Error', 'MISSING_REFRESH_TOKEN', 'ZOHO_REFRESH_TOKEN is not set');
  }

  const headers = await self._getHeaders();
  const amountRupees = self._roundAmount(refundAmountPaise / 100);
  const today = new Date().toISOString().split('T')[0];

  const creditNotePayload = {
    customer_id: zohoContactId,
    location_id: self._LOCATION_ID,
    date: today,
    reference_number: `REFUND-${refundId}`,
    notes: `Refund for order ${orderId} via Razorpay (${refundId})`,
    line_items: [
      {
        name: `Refund — Order ${orderId}`,
        quantity: 1,
        rate: amountRupees,
      },
    ],
  };

  const createResponse = await self._idempotentRetry(() =>
    zohoAxios.post(`${self._baseUrl}/creditnotes`, creditNotePayload, { headers, params: self._defaultParams })
  );

  if (createResponse.data.code !== 0 || !createResponse.data.creditnote) {
    throw new ZohoError(
      'Credit Note Creation Failed',
      'CREDITNOTE_CREATE_FAILED',
      createResponse.data.message || 'Zoho returned no creditnote object'
    );
  }

  const creditNote = createResponse.data.creditnote;

  // Apply the credit note to the original invoice
  const applyResponse = await self._idempotentRetry(() =>
    zohoAxios.post(
      `${self._baseUrl}/creditnotes/${creditNote.creditnote_id}/invoices`,
      { invoices: [{ invoice_id: zohoInvoiceId, amount_applied: amountRupees }] },
      { headers, params: self._defaultParams }
    )
  );

  if (applyResponse.data.code !== 0) {
    throw new ZohoError(
      'Credit Note Apply Failed',
      'CREDITNOTE_APPLY_FAILED',
      applyResponse.data.message || 'Could not apply credit note to invoice'
    );
  }

  serverLogger.info(`[ZohoBooks] Credit note ${creditNote.creditnote_id} created and applied to invoice ${zohoInvoiceId} for refund ${refundId}`);
  return creditNote;
}
