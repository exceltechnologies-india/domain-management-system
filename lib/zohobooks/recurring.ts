/**
 * Zoho Books recurring invoice profile operations.
 */

import axios from 'axios';
import { serverLogger } from '../server-logger';
import type { ZohoBooksService } from '../zohobooks';

/**
 * Create a Recurring Invoice Profile
 */
export async function createRecurringInvoice(
  self: ZohoBooksService,
  order: any,
  user: any,
  items: any[]
): Promise<{ domainName: string, success: boolean, recurringInvoiceId?: string, error?: string }[]> {
  if (!self._hasRefreshToken()) return [];

  const results: { domainName: string, success: boolean, recurringInvoiceId?: string, error?: string }[] = [];

  try {
    // 1. Get or Create Contact
    let contact = await self.getContactByEmail(user.email);
    if (!contact) {
      contact = await self.createContact(user);
    } else {
      // User might have updated details (e.g. re-signed up), sync changes to Zoho
      await self.updateContactDetails(contact.contact_id, user);
    }

    if (!contact) {
      throw new Error('Failed to identify customer in Zoho Books for recurring invoice');
    }

    const headers = await self._getHeaders();

    // 2. Prepare Items
    const hostingItems = items.filter(item => item.itemType === 'hosting' || (item.hostingPlan));

    if (hostingItems.length === 0) {
        serverLogger.info('[ZohoBooks] No hosting items found for recurring invoice.');
        return [];
    }

    for (const item of hostingItems) {
       try {
         const period = item.registrationPeriod || 12; // Default to 12 if missing, usually 1 or 12
         const isMonthly = period < 12;

         const recurrenceFrequency = isMonthly ? 'months' : 'years';
         const repeatEvery = 1;

         // Create Days Before: 7 days for monthly, 30 days for yearly
         const createDaysBefore = isMonthly ? 7 : 30;

         // Start Date: Today + Period
         // If I buy 1 month hosting on Jan 1st, next bill is Feb 1st.
         const today = new Date();
         const startDate = new Date(today);
         if (isMonthly) {
             startDate.setMonth(today.getMonth() + 1);
         } else {
             startDate.setFullYear(today.getFullYear() + 1);
         }
         const startDateStr = startDate.toISOString().split('T')[0];

         let name = item.domainName;
         if (item.itemType === 'hosting' || item.hostingPlan) {
              if (item.hostingPlan) {
                  name = item.hostingPlan.name || 'Hosting Service';
              } else if (name && name.startsWith('hosting-')) {
                  name = 'Hosting Service';
              } else {
                  name = 'Hosting Service';
              }
         }
         const displayDomain = item.linkedDomain || item.domainName || '';

         const description = isMonthly
          ? `Hosting Renewal for ${displayDomain} (1 Month)`
          : `Hosting Renewal for ${displayDomain} (1 Year)`;

         const recurringData = {
             customer_id: contact.contact_id,
             location_id: self._LOCATION_ID,
             recurrence_name: `Hosting Renewal - ${displayDomain}`,
             start_date: startDateStr,
             recurrence_frequency: recurrenceFrequency,
             repeat_every: repeatEvery,
             is_never_expiring: true, // Run forever until cancelled
             create_days_before: createDaysBefore,
             line_items: [
                 {
                     name: name,
                     description: description,
                     rate: self._roundAmount(item.price),
                     quantity: 1
                 }
             ],
             notes: `Auto-generated recurring profile for Order: ${order.orderId}`
         };

         serverLogger.info(`[ZohoBooks] Creating Recurring Invoice for ${displayDomain}...`);

         // We create one profile per hosting item to allow independent cancellation
         const response = await self._idempotentRetry(() =>
             axios.post(`${self._baseUrl}/recurringinvoices`, recurringData, { headers, params: self._defaultParams })
         );

         if (response.data.code !== 0) {
             const errMsg = response.data.message || 'Unknown Zoho API Error';
             serverLogger.warn(`[ZohoBooks] Failed to create recurring invoice for ${displayDomain}: ${errMsg}`);
             results.push({
                 domainName: item.domainName,
                 success: false,
                 error: errMsg
             });
         } else {
             const recurringId = response.data.recurring_invoice.recurring_invoice_id;
             serverLogger.info(`[ZohoBooks] Recurring Invoice created for ${displayDomain} (ID: ${recurringId})`);
             results.push({
                 domainName: item.domainName,
                 success: true,
                 recurringInvoiceId: recurringId
             });
         }
       } catch (itemError: any) {
           // Catch individual item errors loop to continue processing others
           const itemErrMsg = itemError.response?.data?.message || itemError.message;
           serverLogger.error(`[ZohoBooks] Exception processing item ${item.domainName}: ${itemErrMsg}`);
           results.push({
               domainName: item.domainName,
               success: false,
               error: itemErrMsg
           });
       }
    }

    return results;

  } catch (error: any) {
    serverLogger.error('[ZohoBooks] Recurring Invoice creation process failed', error.response?.data || error.message);
    // If the entire process fails (e.g. Auth), we can't map to specific domains easily unless we passed them all.
    // But we can return an empty list or try to map all items as failed if needed.
    // For now, return empty which means "no results recorded".
    return [];
  }
}
