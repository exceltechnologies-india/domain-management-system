/**
 * Zoho Books invoice operations.
 */

import axios from 'axios';
import { serverLogger } from '../server-logger';
import { SAC_CODE, formatSubscriptionPeriod } from '../invoiceUtils';
import type { ZohoBooksService } from '../zohobooks';
import { ZohoError } from '../zohobooks';
import type {
  ZohoInvoice,
  ZohoOrderInput,
  ZohoOrderItemInput,
  ZohoUserInput,
} from './types';
import { unwrapZohoError } from './types';

/**
 * Create an invoice and optionally apply payment
 */
export async function createInvoice(
  self: ZohoBooksService,
  order: ZohoOrderInput,
  user: ZohoUserInput,
  items: ZohoOrderItemInput[],
  paymentMode: string = 'Razorpay',
  shouldApplyPayment: boolean = true
): Promise<ZohoInvoice | null> {
  if (!self._hasRefreshToken()) {
    throw new ZohoError('Config Error', 'MISSING_REFRESH_TOKEN', 'ZOHO_REFRESH_TOKEN environment variable is not set — Zoho Books integration is disabled');
  }

  try {
    // 🛡️ IDEMPOTENCY: Check if an invoice with this OrderID already exists in Zoho
    const orderId = order.orderId || order.reference_number;
    if (orderId) {
      const existingInvoices = await self.getInvoicesByReferenceNumber(orderId);
      if (existingInvoices.length > 0) {
          serverLogger.info(`[ZohoBooks] DUPLICATE DETECTED: Invoice already exists in Zoho for Order ${orderId}. Skipping creation.`);
          return existingInvoices[0]; // Return the first matching invoice
      }
    }

    // 1. Get or Create Contact
    let contact = await self.getContactByEmail(user.email);
    if (!contact) {
      contact = await self.createContact(user);
    } else {
      // User might have updated details (e.g. re-signed up), sync changes to Zoho
      await self.updateContactDetails(contact.contact_id, user);
    }

    if (!contact) {
      throw new Error('Failed to identify customer in Zoho Books');
    }

    const customerState = contact.billing_address?.state || user.address?.state || '';
    const isInterState = customerState && customerState.toLowerCase() !== self._ORG_STATE.toLowerCase();
    const taxId = isInterState ? self._TAX_IDS.IGST18 : self._TAX_IDS.GST18;

    const headers = await self._getHeaders();

    // 2. Prepare Invoice Items
    const lineItems = items.map(item => {
      let name = item.domainName;
      // If it's hosting, prefer the plan name.
      if (item.itemType === 'hosting') {
          if (item.hostingPlan) {
              name = item.hostingPlan.name || 'Hosting Service';
          } else if (name && name.startsWith('hosting-')) {
               name = 'Hosting Service'; // Fallback if no plan object and domainName is an ID
          } else {
              name = 'Hosting Service'; // Final fallback
          }
      }
      // For domains, name is already item.domainName from the default above.

      const displayDomain = item.linkedDomain || item.domainName || '';

      const isTestHosting = item.itemType === 'hosting' && item.periodUnit === 'days';
      const actualDuration = item.registrationPeriod || 1;
      const rate = isTestHosting ? 1 : self._roundAmount(item.price ?? 0);
      const quantity = isTestHosting ? 1 : actualDuration;
      const startDate = order.createdAt ? new Date(order.createdAt) : new Date();
      const periodText = formatSubscriptionPeriod(
        startDate,
        actualDuration,
        (item.periodUnit || (item.itemType === 'hosting' ? 'months' : 'years')) as 'minutes' | 'months' | 'years' | 'days',
      );

      let description = '';
      if (item.itemType === 'domain') {
          description = `Domain Registration\nDomain Name: ${item.domainName}\nSubscription Period: ${periodText}\nSAC: ${SAC_CODE}`;
      } else {
          const planName = item.hostingPlan?.name || 'Service';
          const features = item.hostingPlan?.features?.slice(0, 4).join(', ') || '';
          description = `Web Hosting: ${planName}\nDomain Name: ${displayDomain}\nSubscription Period: ${periodText}\nSAC: ${SAC_CODE}${features ? `\nIncluded Features: ${features}` : ''}`;
      }

      return {
         name: name,
         description: description,
         rate: rate,
         quantity: quantity,
         tax_id: taxId
      };
    });

    const invoiceData = {
      customer_id: contact.contact_id,
      location_id: self._LOCATION_ID,
      line_items: lineItems,
      is_inclusive_tax: true, // Tell Zoho the rates are inclusive of GST
      date: new Date().toISOString().split('T')[0],
      due_date: new Date().toISOString().split('T')[0],
      reference_number: order.orderId,
      notes: `Created from App. ID: ${order.orderId}\nCustomer Email: ${user.email}\nPayment Mode: ${paymentMode}`
    };

    // 3. Create Invoice
    // Use params: { send: false } to not email automatically if you handle emails yourself
    let response;
    try {
      response = await self._idempotentRetry(() =>
          axios.post(`${self._baseUrl}/invoices`, invoiceData, {
              headers,
              params: { send: false, ...self._defaultParams }
          })
      );
    } catch (invoiceError) {
      const unwrapped = unwrapZohoError(invoiceError);
      const errorData = unwrapped.data;
      const errorMessage = errorData?.message || unwrapped.message;

      // 🛡️ FALLBACK: If invoice creation fails due to GST issues, try to fix contact and retry once
      if (errorData?.code === 2 && errorMessage.toLowerCase().includes('gst')) {
          serverLogger.warn(`[ZohoBooks] Invoice GST error for ${user.email}. Attempting contact fix.`, errorMessage);

          const fixed = await self.updateContactToConsumer(contact.contact_id);
          if (fixed) {
              serverLogger.info(`[ZohoBooks] Contact fixed. Retrying invoice creation for ${orderId}...`);
              response = await self._idempotentRetry(() =>
                  axios.post(`${self._baseUrl}/invoices`, invoiceData, {
                      headers,
                      params: { send: false, ...self._defaultParams }
                  })
              );
          } else {
              throw invoiceError; // Fix failed, rethrow original
          }
      }
      // 🛡️ FALLBACK: Tax ID mismatch (IGST vs CGST/SGST)
      else if (errorData?.code === 3032) {
          const isIntraState = taxId === self._TAX_IDS.GST18;
          const newTaxId = isIntraState ? self._TAX_IDS.IGST18 : self._TAX_IDS.GST18;
          const taxTypeLabel = isIntraState ? "Inter-state" : "Intra-state";

          serverLogger.warn(`[ZohoBooks] Tax mismatch for ${user.email} (tried ${isIntraState ? 'Local' : 'Inter-state'}). Retrying with ${taxTypeLabel}...`);

          // Re-prepare line items with the swapped tax ID
          const swappedLineItems = invoiceData.line_items.map((li) => ({ ...li, tax_id: newTaxId }));
          const retryData = { ...invoiceData, line_items: swappedLineItems };

          response = await self._idempotentRetry(() =>
              axios.post(`${self._baseUrl}/invoices`, retryData, {
                  headers,
                  params: { send: false, ...self._defaultParams }
              })
          );
      }
      else {
          throw invoiceError; // Not a GST or Tax error, rethrow
      }
    }

    if (response && response.data.code !== 0) {
      throw new Error(response.data.message);
    }

    const invoice = response.data.invoice;
    serverLogger.info(`[ZohoBooks] Invoice created: ${invoice.invoice_number}`);

    // 4. Record Payment (Mark as Sent first often required before payment?)
    // Zoho API often requires Invoice to be Sent before Payment, or just Open.
    // We can mark it as sent or just apply payment directly usually works if status is 'draft'.

    // Let's mark as sent to be clean
    try {
      await self._idempotentRetry(() =>
          axios.post(`${self._baseUrl}/invoices/${invoice.invoice_id}/status/sent`, {}, { headers, params: self._defaultParams })
      );
    } catch (e) {
        // Ignore if already sent or not allowed, try payment anyway
    }

    if (shouldApplyPayment && invoice.total > 0) {
      try {
        const paymentData = {
          customer_id: contact.contact_id,
          payment_mode: paymentMode, // Use provided mode
          amount: invoice.total,
          date: new Date().toISOString().split('T')[0],
          reference_number: order.razorpayPaymentId || order.paymentId || `ADMIN-${Date.now()}`,
          invoices: [
              {
                  invoice_id: invoice.invoice_id,
                  amount_applied: invoice.total
              }
          ]
        };

        const paymentResponse = await self._idempotentRetry(() =>
            axios.post(`${self._baseUrl}/customerpayments`, paymentData, { headers, params: self._defaultParams })
        );

        if (paymentResponse.data.code === 0) {
           serverLogger.info(`[ZohoBooks] Payment recorded for invoice ${invoice.invoice_number}`);
        } else {
           serverLogger.warn(`[ZohoBooks] Failed to record payment: ${paymentResponse.data.message}`);
        }
      } catch (paymentError) {
        const u = unwrapZohoError(paymentError);
        serverLogger.warn(`[ZohoBooks] Payment recording failed, but invoice was created:`, u.data || u.message);
        // Do not throw, return invoice since it was successfully created
      }
    } else {
      const reason = invoice.total <= 0 ? "total is zero" : "shouldApplyPayment=false";
      serverLogger.info(`[ZohoBooks] Skipping payment recording for invoice ${invoice.invoice_number} (${reason})`);
    }

    return invoice;

  } catch (error) {
    const unwrapped = unwrapZohoError(error);
    if (unwrapped.data?.code === 103001) {
      serverLogger.error('[ZohoBooks] Invoice creation failed — Zoho Books subscription expired. Upgrade required.', unwrapped.data.message);
      throw new ZohoError('Subscription Expired', 'SUBSCRIPTION_EXPIRED', 'Zoho Books subscription has expired. Please renew to generate invoices.');
    }
    serverLogger.error('[ZohoBooks] Invoice creation failed', unwrapped.data || unwrapped.message);
    throw error;
  }
}

/**
 * Get invoices by Email
 */
export async function getInvoicesByEmail(self: ZohoBooksService, email: string): Promise<ZohoInvoice[]> {
  if (!self._hasRefreshToken()) {
    serverLogger.warn('[ZohoBooks] Missing refresh token, cannot fetch invoices.');
    return [];
  }

  try {
    serverLogger.info(`[ZohoBooks] Fetching invoices for email: ${email}`);
    const contact = await self.getContactByEmail(email);
    if (!contact) {
      serverLogger.warn(`[ZohoBooks] Contact not found for email: ${email}`);
      return [];
    }

    serverLogger.info(`[ZohoBooks] Found contact: ${contact.contact_id} for email: ${email}`);

    const headers = await self._getHeaders();
    const response = await self._idempotentRetry(() =>
        axios.get(`${self._baseUrl}/invoices`, {
          headers,
          params: {
            customer_id: contact.contact_id,
            ...self._defaultParams,
            sort_column: 'date',
            sort_order: 'D'
          }
        })
    );

    if (response.data.code === 0) {
      serverLogger.info(`[ZohoBooks] Found ${response.data.invoices.length} invoices for ${email}`);

      // Sort by invoice_number DESC to ensure sequential order (e.g. INV-00014 before INV-00013)
      return (response.data.invoices as ZohoInvoice[]).sort((a, b) =>
          (b.invoice_number || "").localeCompare(a.invoice_number || "", undefined, { numeric: true, sensitivity: 'base' })
      );
    }
    serverLogger.warn(`[ZohoBooks] Failed to list invoices. Code: ${response.data.code}, Message: ${response.data.message}`);
    return [];
  } catch (error) {
    const unwrapped = unwrapZohoError(error);
    const errCode = unwrapped.data?.code;
    const errMsg = unwrapped.data?.message || unwrapped.message;

    serverLogger.error(`[ZohoBooks] Failed to fetch invoices: Code ${errCode}, Msg: ${errMsg}`);

    // PROBE: Check if we have global invoice read access
    if (errCode === 57) {
      try {
         serverLogger.info('[ZohoBooks] Probing global invoice access...');
         const headers = await self._getHeaders();
         const probeParams = {
           ...self._defaultParams,
           page: 1,
           per_page: 1
         };
         await axios.get(`${self._baseUrl}/invoices`, { headers, params: probeParams });
         serverLogger.warn('[ZohoBooks] PROBE SUCCESS: You HAVE access to invoices. The issue is likely with the specific Customer ID.');
      } catch (probeError) {
         const u = unwrapZohoError(probeError);
         serverLogger.error('[ZohoBooks] PROBE FAILED: You likely DO NOT have "ZohoBooks.invoices.READ" scope.', u.data || u.message);
      }
    }

    return [];
  }
}

/**
 * Get Invoice PDF from Zoho Books
 */
export async function getInvoicePdf(self: ZohoBooksService, invoiceId: string): Promise<ArrayBuffer | null> {
  if (!self._hasRefreshToken() || !invoiceId) return null;

  try {
    const headers = await self._getHeaders();
    // Zoho Books API to get PDF: /invoices/{invoice_id}?accept=pdf
    const response = await self._idempotentRetry(() =>
        axios.get(`${self._baseUrl}/invoices/${invoiceId}`, {
          headers: {
              ...headers,
              'Accept': 'application/pdf'
          },
          responseType: 'arraybuffer',
          params: {
              accept: 'pdf',
              ...self._defaultParams
          }
        })
    );

    return response.data;
  } catch (error) {
    const u = unwrapZohoError(error);
    serverLogger.error('[ZohoBooks] Failed to fetch invoice PDF', u.data || u.message);
    return null;
  }
}

/**
 * Get All Invoices (Admin)
 */
export async function getAllInvoices(
  self: ZohoBooksService,
  page = 1,
  perPage = 20,
): Promise<{ invoices: ZohoInvoice[]; page_context: Record<string, unknown> }> {
  if (!self._hasRefreshToken()) {
    serverLogger.warn('[ZohoBooks] Missing refresh token, cannot fetch all invoices.');
    return { invoices: [], page_context: {} };
  }

  try {
    const headers = await self._getHeaders();
    const response = await self._idempotentRetry(() =>
        axios.get(`${self._baseUrl}/invoices`, {
          headers,
          params: {
            ...self._defaultParams,
            page,
            per_page: perPage,
            sort_column: 'date',
            sort_order: 'D'
          }
        })
    );

    if (response.data.code === 0) {
      // Sort by invoice_number DESC to ensure sequential order
      const sortedInvoices = (response.data.invoices as ZohoInvoice[]).sort((a, b) =>
          (b.invoice_number || "").localeCompare(a.invoice_number || "", undefined, { numeric: true, sensitivity: 'base' })
      );

      return {
          invoices: sortedInvoices,
          page_context: response.data.page_context
      };
    }
    return { invoices: [], page_context: {} };
  } catch (error) {
    const u = unwrapZohoError(error);
    serverLogger.error('[ZohoBooks] Failed to fetch all invoices', u.data || u.message);
    return { invoices: [], page_context: {} };
  }
}

/**
 * Get Invoice by ID
 */
export async function getInvoiceById(self: ZohoBooksService, invoiceId: string): Promise<ZohoInvoice | null> {
  if (!self._hasRefreshToken() || !invoiceId) return null;

  try {
    const headers = await self._getHeaders();
    const response = await self._idempotentRetry(() =>
        axios.get(`${self._baseUrl}/invoices/${invoiceId}`, { headers, params: self._defaultParams })
    );

    if (response.data.code === 0) {
      return response.data.invoice;
    }
    return null;
  } catch (error) {
    const u = unwrapZohoError(error);
    serverLogger.error('[ZohoBooks] Error fetching invoice by ID', u.data || u.message);
    return null;
  }
}

/**
 * Apply Payment to Invoice
 */
export async function applyPaymentToInvoice(
  self: ZohoBooksService,
  invoiceId: string,
  amount: number,
  paymentMode: string = 'Razorpay',
  referenceNumber: string
): Promise<boolean> {
  if (!self._hasRefreshToken() || !invoiceId) return false;

  try {
    const invoice = await self.getInvoiceById(invoiceId);
    if (!invoice) {
      throw new Error(`Invoice ${invoiceId} not found`);
    }

    const headers = await self._getHeaders();

    const roundedAmount = self._roundAmount(amount);
    const paymentData = {
      customer_id: invoice.customer_id,
      payment_mode: paymentMode,
      amount: roundedAmount,
      date: new Date().toISOString().split('T')[0],
      reference_number: referenceNumber,
      invoices: [
        {
          invoice_id: invoiceId,
          amount_applied: roundedAmount
        }
      ]
    };

    const response = await self._idempotentRetry(() =>
        axios.post(`${self._baseUrl}/customerpayments`, paymentData, { headers, params: self._defaultParams })
    );

    return response.data.code === 0;
  } catch (error) {
    const u = unwrapZohoError(error);
    serverLogger.error('[ZohoBooks] Error applying payment to invoice', u.data || u.message);
    return false;
  }
}

/**
 * Search for invoices by reference number (Order ID)
 */
export async function getInvoicesByReferenceNumber(self: ZohoBooksService, referenceNumber: string): Promise<ZohoInvoice[]> {
  if (!self._hasRefreshToken() || !referenceNumber) return [];

  try {
    const headers = await self._getHeaders();
    const response = await self._idempotentRetry(() =>
        axios.get(`${self._baseUrl}/invoices`, {
          headers,
          params: {
            reference_number: referenceNumber,
            ...self._defaultParams
          }
        })
    );

    if (response.data.code === 0 && response.data.invoices) {
      return response.data.invoices;
    }
    return [];
  } catch (error) {
    const u = unwrapZohoError(error);
    serverLogger.error('[ZohoBooks] Failed to fetch invoices by reference number', u.data || u.message);
    return [];
  }
}
