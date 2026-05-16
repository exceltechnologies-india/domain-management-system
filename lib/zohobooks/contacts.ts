/**
 * Zoho Books contact + contact-person operations.
 *
 * These functions take a `self: ZohoBooksService` argument so they can
 * reuse the singleton's authenticated headers, baseUrl, and retry helper
 * without needing their own auth state.
 */

import axios from 'axios';
import { serverLogger } from '../server-logger';
import type { ZohoBooksService } from '../zohobooks';
import { ZohoError } from '../zohobooks';
import type {
  ZohoContact,
  ZohoContactPerson,
  ZohoUserInput,
} from './types';
import { unwrapZohoError } from './types';

/**
 * Search for a contact by email
 */
export async function getContactByEmail(self: ZohoBooksService, email: string): Promise<ZohoContact | null> {
  if (!self._hasRefreshToken()) {
    throw new ZohoError('Config Error', 'MISSING_REFRESH_TOKEN', 'ZOHO_REFRESH_TOKEN is not set');
  }

  try {
    const headers = await self._getHeaders();
    const response = await axios.get(`${self._baseUrl}/contacts`, {
      headers,
      params: { email, ...self._defaultParams }
    });

    if (response.data.code === 0 && response.data.contacts.length > 0) {
      return response.data.contacts[0];
    }
    return null;
  } catch (error) {
    // Auth/config errors must propagate so callers can distinguish "not found" from "broken auth"
    if (error instanceof ZohoError) throw error;
    const u = unwrapZohoError(error);
    serverLogger.error('[ZohoBooks] Error fetching contact', u.data || u.message);
    return null;
  }
}

export async function getContactByName(self: ZohoBooksService, name: string): Promise<ZohoContact | null> {
  if (!self._hasRefreshToken()) {
    throw new ZohoError('Config Error', 'MISSING_REFRESH_TOKEN', 'ZOHO_REFRESH_TOKEN is not set');
  }

  try {
    const headers = await self._getHeaders();
    const response = await axios.get(`${self._baseUrl}/contacts`, {
      headers,
      params: { ...self._defaultParams, contact_name: name }
    });

    if (response.data.code === 0 && response.data.contacts.length > 0) {
      return response.data.contacts[0];
    }
    return null;
  } catch (error) {
    // Auth/config errors must propagate so callers can distinguish "not found" from "broken auth"
    if (error instanceof ZohoError) throw error;
    const u = unwrapZohoError(error);
    serverLogger.error('[ZohoBooks] Error fetching contact by name', u.data || u.message);
    return null;
  }
}

/**
 * Create a new contact in Zoho Books
 */
export async function createContact(self: ZohoBooksService, user: ZohoUserInput): Promise<ZohoContact | null> {
  if (!self._hasRefreshToken()) return null;

  try {
    const headers = await self._getHeaders();
    const contactData: Record<string, unknown> & { gst_no?: string; gst_treatment?: string; contact_name?: string } = {
      contact_name: `${user.firstName} ${user.lastName}`.trim(),
      company_name: user.companyName || '',
      contact_type: 'customer',
      contact_persons: [
        {
          first_name: user.firstName,
          last_name: user.lastName,
          email: user.email,
          phone: user.phone,
          is_primary_contact: true
        }
      ],
      // Only set GST fields if user has a valid GST number
      // 🛡️ SANITIZE: Zoho is strict about GST format (no spaces, uppercase)
      ...(user.gstNumber && user.gstNumber.trim()
        ? { gst_no: user.gstNumber.trim().replace(/\s/g, '').toUpperCase(), gst_treatment: 'business_registered' }
        : { gst_treatment: 'consumer' }
      ),
      billing_address: user.address ? {
        address: user.address.line1,
        city: user.address.city,
        state: user.address.state,
        zip: user.address.zipcode,
        country: user.address.country,
      } : undefined
    };

    serverLogger.info('[ZohoBooks] Creating contact with data:', JSON.stringify(contactData, null, 2));

    try {
      const response = await self._idempotentRetry(() =>
          axios.post(`${self._baseUrl}/contacts`, contactData, { headers, params: self._defaultParams })
      );

      if (response.data.code === 0) {
        return response.data.contact;
      }
      throw new Error(response.data.message);
    } catch (error) {
      const unwrapped = unwrapZohoError(error);
      const errorData = unwrapped.data;
      const errorMessage = errorData?.message || unwrapped.message;

      // 🛡️ FALLBACK: If Zoho rejects any GST-related field (gst_no, gst_treatment, gstIN, etc.), retry as a Consumer
      if (errorData?.code === 2 && errorMessage.toLowerCase().includes('gst')) {
         serverLogger.warn(`[ZohoBooks] GST validation failed for ${user.email}. Retrying as consumer.`, {
           originalError: errorMessage,
           invalidGst: contactData.gst_no
         });

         // Create a sanitize copy without GST fields
         const fallbackData = { ...contactData };
         delete fallbackData.gst_no;
         fallbackData.gst_treatment = 'consumer';

         const retryResponse = await self._idempotentRetry(() =>
             axios.post(`${self._baseUrl}/contacts`, fallbackData, { headers, params: self._defaultParams })
         );

         if (retryResponse.data.code === 0) {
           serverLogger.info(`✅ [ZohoBooks] Contact created via fallback for ${user.email}`);
           return retryResponse.data.contact;
         }
      }

      // 🛡️ FALLBACK: Zoho contact_name must be unique — if duplicate name exists, find and return it
      if (errorData?.code === 3062) {
        const contactName = contactData.contact_name;
        serverLogger.warn(`[ZohoBooks] Duplicate contact name "${contactName}" — searching for existing contact.`);
        if (contactName) {
          const existing = await self.getContactByName(contactName);
          if (existing) {
            serverLogger.info(`[ZohoBooks] Found existing contact by name: ${existing.contact_id}`);
            return existing;
          }
        }
      }

      serverLogger.error('[ZohoBooks] Error creating contact', errorData || unwrapped.message);
      throw error;
    }
  } catch (error) {
    const u = unwrapZohoError(error);
    serverLogger.error('[ZohoBooks] Outer Error creating contact', u.data || u.message);
    throw error;
  }
}

/**
 * Update an existing contact's details to match user profile
 */
export async function updateContactDetails(self: ZohoBooksService, contactId: string, user: ZohoUserInput): Promise<boolean> {
  if (!self._hasRefreshToken()) return false;

  try {
    const headers = await self._getHeaders();

    // 1. Update the Main Contact (Organization/Display Name)
    const isGstValid = !!user.gstNumber && self._isValidGst(user.gstNumber);
    const cleanGst = isGstValid && user.gstNumber ? user.gstNumber.trim().replace(/\s/g, '').toUpperCase() : '';

    const updateData: Record<string, unknown> = {
      contact_name: `${user.firstName} ${user.lastName}`.trim(),
      company_name: user.companyName || '',
      gst_no: cleanGst,
      gst_treatment: isGstValid ? 'business_registered' : 'consumer',
      billing_address: user.address ? {
        address: (user.address.line1 || '').substring(0, 100), // Safety truncation for line 1
        city: user.address.city || '',
        state: user.address.state || '',
        zip: user.address.zipcode || '',
        country: user.address.country || 'IN',
      } : undefined
    };

    serverLogger.info(`[ZohoBooks] Updating main contact details for ${contactId} with data:`, JSON.stringify(updateData, null, 2));

    await self._idempotentRetry(() =>
        axios.put(`${self._baseUrl}/contacts/${contactId}`, updateData, { headers, params: self._defaultParams })
    );

    // 2. Update the Primary Contact Person (First/Last Name)
    // Zoho often uses the Contact Person's name for invoice "Bill To" sections.
    try {
      const contactPersons = await self.getContactPersons(contactId);
      const primaryPerson = contactPersons.find((p) => p.is_primary_contact);

      if (primaryPerson?.contact_person_id) {
        serverLogger.info(`[ZohoBooks] Updating primary contact person ${primaryPerson.contact_person_id} for contact ${contactId}`);
        await self.updateContactPerson(primaryPerson.contact_person_id, user);
      }
    } catch (personError) {
      serverLogger.warn(`[ZohoBooks] Failed to update contact person for ${contactId}, but main contact updated.`, (personError as Error)?.message);
    }

    return true;
  } catch (error) {
    const u = unwrapZohoError(error);
    serverLogger.error(`[ZohoBooks] Failed to update contact ${contactId}`, u.data || u.message);
    return false; // Proceed anyway
  }
}

/**
 * Get all contact persons for a contact
 */
export async function getContactPersons(self: ZohoBooksService, contactId: string): Promise<ZohoContactPerson[]> {
  if (!self._hasRefreshToken()) return [];

  try {
    const headers = await self._getHeaders();
    const response = await axios.get(`${self._baseUrl}/contacts/${contactId}/contactpersons`, { headers, params: self._defaultParams });

    if (response.data.code === 0) {
      return response.data.contact_persons;
    }
    return [];
  } catch (error) {
    const u = unwrapZohoError(error);
    serverLogger.error(`[ZohoBooks] Error fetching contact persons for ${contactId}`, u.data || u.message);
    return [];
  }
}

/**
 * Update a specific contact person
 */
export async function updateContactPerson(self: ZohoBooksService, contactPersonId: string, user: ZohoUserInput): Promise<boolean> {
  if (!self._hasRefreshToken()) return false;

  try {
    const headers = await self._getHeaders();
    const personData = {
      first_name: user.firstName,
      last_name: user.lastName,
      email: user.email,
      phone: user.phone,
      mobile: user.phone
    };

    serverLogger.info(`[ZohoBooks] Updating contact person ${contactPersonId} with data:`, JSON.stringify(personData, null, 2));

    const response = await self._idempotentRetry(() =>
        axios.put(`${self._baseUrl}/contacts/contactpersons/${contactPersonId}`, personData, { headers, params: self._defaultParams })
    );

    return response.data.code === 0;
  } catch (error) {
    const u = unwrapZohoError(error);
    serverLogger.error(`[ZohoBooks] Error updating contact person ${contactPersonId}`, u.data || u.message);
    return false;
  }
}

/**
 * Update an existing contact's GST status to Consumer
 * Use this as a fallback when GST validation blocks invoices
 */
export async function updateContactToConsumer(self: ZohoBooksService, contactId: string): Promise<boolean> {
  if (!self._hasRefreshToken()) return false;

  try {
    const headers = await self._getHeaders();
    const updateData = {
      gst_treatment: 'consumer',
      gst_no: '' // Clearing GST number
    };

    serverLogger.info(`[ZohoBooks] Forcing contact ${contactId} to consumer status`);

    const response = await self._idempotentRetry(() =>
        axios.put(`${self._baseUrl}/contacts/${contactId}`, updateData, { headers, params: self._defaultParams })
    );

    return response.data.code === 0;
  } catch (error) {
    const u = unwrapZohoError(error);
    serverLogger.error(`[ZohoBooks] Failed to update contact ${contactId} to consumer`, u.data || u.message);
    return false;
  }
}
