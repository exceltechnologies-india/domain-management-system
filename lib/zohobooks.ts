import axios from 'axios';
import { serverLogger } from './server-logger';
import { SAC_CODE, formatSubscriptionPeriod } from './invoiceUtils';

interface ZohoConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  orgId?: string;
  dc: string;
}

interface ZohoTokenResponse {
  access_token: string;
  expires_in: number;
  api_domain: string;
  token_type: string;
  error?: string;
}

export class ZohoError extends Error {
    constructor(
        public title: string, 
        public code: string, 
        public details: any
    ) {
        super(`${title}: ${JSON.stringify(details)}`);
        this.name = 'ZohoError';
    }
}

export class ZohoBooksService {
  private static instance: ZohoBooksService;
  private config: ZohoConfig;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private baseUrl: string = 'https://www.zohoapis.in/books/v3'; // Default to .in
  private _subscriptionExpired: boolean = false;

  private constructor() {
    this.config = {
      clientId: process.env.ZOHO_CLIENT_ID || '',
      clientSecret: process.env.ZOHO_CLIENT_SECRET || '',
      refreshToken: process.env.ZOHO_REFRESH_TOKEN || '',
      orgId: process.env.ZOHO_ORG_ID,
      dc: process.env.ZOHO_DC || '.in',
    };

    // Set base URL based on DC
    const dc = this.config.dc.replace(/^\./, ''); // remove leading dot if present
    if (dc === 'com') {
        this.baseUrl = 'https://www.zohoapis.com/books/v3';
    } else if (dc === 'eu') {
        this.baseUrl = 'https://www.zohoapis.eu/books/v3';
    } else {
        this.baseUrl = 'https://www.zohoapis.in/books/v3';
    }

    if (!this.config.clientId || !this.config.clientSecret || !this.config.refreshToken) {
      serverLogger.warn('[ZohoBooks] Missing configuration. Zoho Books integration will be disabled.');
    }
  }

  // GST Tax IDs are organisation-specific in Zoho Books.
  // Set ZOHO_TAX_ID_GST18 and ZOHO_TAX_ID_IGST18 in Cloud Run env vars.
  // Fallback values match the original IDs for backwards compatibility,
  // but a missing env var in a new account will cause Zoho validation errors.
  private static readonly TAX_IDS = {
    GST18: process.env.ZOHO_TAX_ID_GST18 || '3650677000000328294',
    IGST18: process.env.ZOHO_TAX_ID_IGST18 || '3650677000000328134',
  };

  // Location ID for "Domain Hosting Online Business" — used on all invoices instead of Head Office.
  // Override via ZOHO_LOCATION_ID env var if the ID changes.
  private static get LOCATION_ID(): string {
    return process.env.ZOHO_LOCATION_ID || '3847734000000059031';
  }

  private static get ORG_STATE(): string {
    if (!process.env.ZOHO_ORG_STATE) {
      throw new Error("ZOHO_ORG_STATE environment variable is required for correct GST tax type calculation");
    }
    return process.env.ZOHO_ORG_STATE;
  }

  public static getInstance(): ZohoBooksService {
    if (!ZohoBooksService.instance) {
      ZohoBooksService.instance = new ZohoBooksService();
    }
    return ZohoBooksService.instance;
  }

  // Round to 2 decimal places before sending to Zoho to avoid floating-point noise
  private static roundAmount(value: number): number {
    return Math.round(value * 100) / 100;
  }

  public isSubscriptionExpired(): boolean {
    return this._subscriptionExpired;
  }

  // Fire-and-forget: persist expiry to DB so it survives server restarts.
  // Uses dynamic imports to avoid pulling mongoose into Edge runtime contexts.
  private persistSubscriptionExpiredToDB(): void {
    (async () => {
      try {
        const { connectToDatabase } = await import("./mongoose");
        const Settings = (await import("../models/Settings")).default;
        await connectToDatabase();
        await Settings.findOneAndUpdate(
          { key: "zoho.subscription_expired" },
          {
            key: "zoho.subscription_expired",
            value: { expired: true, detectedAt: new Date() },
            category: "zoho",
            updatedBy: "system",
            updatedAt: new Date(),
          },
          { upsert: true }
        );
      } catch (e: any) {
        serverLogger.warn("[ZohoBooks] Could not persist subscription expiry to DB", e?.message);
      }
    })();
  }

  // Call this when the subscription is confirmed active again (e.g., after upgrade).
  public clearSubscriptionExpiredInDB(): void {
    this._subscriptionExpired = false;
    (async () => {
      try {
        const { connectToDatabase } = await import("./mongoose");
        const Settings = (await import("../models/Settings")).default;
        await connectToDatabase();
        await Settings.deleteOne({ key: "zoho.subscription_expired" });
      } catch (e: any) {
        serverLogger.warn("[ZohoBooks] Could not clear subscription expiry from DB", e?.message);
      }
    })();
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      const dc = this.config.dc.replace(/^\./, '');
      const authHost = dc === 'com' ? 'https://accounts.zoho.com' : `https://accounts.zoho.${dc}`;
      
      const params = new URLSearchParams();
      params.append('refresh_token', this.config.refreshToken);
      params.append('client_id', this.config.clientId);
      params.append('client_secret', this.config.clientSecret);
      params.append('grant_type', 'refresh_token');

      const response = await axios.post<ZohoTokenResponse>(
        `${authHost}/oauth/v2/token`, 
        params
      );

      if (response.data.error) {
        throw new Error(`Zoho OAuth Error: ${response.data.error}`);
      }

      this.accessToken = response.data.access_token;
      // Expires in is usually seconds. Subtract a buffer of 60 seconds.
      this.tokenExpiry = Date.now() + (response.data.expires_in * 1000) - 60000;

      return this.accessToken!;
    } catch (error: any) {
      const errorMessage = error.response?.data?.error || error.message;
      serverLogger.error('[ZohoBooks] Failed to refresh token', errorMessage);
       // Throw a specific error so we can catch it specifically if needed
       throw new ZohoError('Auth Failed', 'AUTH_ERROR', errorMessage);
    }
  }

  private async idempotentRetry<T>(operation: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
      let lastError: any;
      for (let i = 0; i < retries; i++) {
          try {
              return await operation();
          } catch (error: any) {
              lastError = error;
              // Track subscription expiry so the health check can surface it
              // without needing a write-level probe call.
              if (error.response?.data?.code === 103001 && !this._subscriptionExpired) {
                  this._subscriptionExpired = true;
                  this.persistSubscriptionExpiredToDB();
              }
              // Check if retryable: Network errors, 5xx, or 429
              const status = error.response?.status;
              const isRetryable = !status || status >= 500 || status === 429;

              if (!isRetryable) {
                  throw error; // Don't retry validation or auth errors
              }

              serverLogger.warn(`[ZohoBooks] Transient error (Attempt ${i + 1}/${retries}), retrying...`, error.message);
              await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i))); // Exponential backoff
          }
      }
      throw lastError;
  }

  private async getHeaders() {
    const token = await this.getAccessToken();
    const headers: any = {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    };
    if (this.config.orgId) {
      headers['X-com-zoho-books-organizationid'] = this.config.orgId;
    }
    return headers;
  }

  // Always include organization_id in every API call so requests are
  // scoped to our org even when the OAuth token has access to multiple.
  private get defaultParams(): Record<string, string> {
    return this.config.orgId ? { organization_id: this.config.orgId } : {};
  }

  /**
   * Search for a contact by email
   */
  async getContactByEmail(email: string): Promise<any | null> {
    if (!this.config.refreshToken) {
      throw new ZohoError('Config Error', 'MISSING_REFRESH_TOKEN', 'ZOHO_REFRESH_TOKEN is not set');
    }

    try {
      const headers = await this.getHeaders();
      const response = await axios.get(`${this.baseUrl}/contacts`, {
        headers,
        params: { email, ...this.defaultParams }
      });

      if (response.data.code === 0 && response.data.contacts.length > 0) {
        return response.data.contacts[0];
      }
      return null;
    } catch (error: any) {
      // Auth/config errors must propagate so callers can distinguish "not found" from "broken auth"
      if (error instanceof ZohoError) throw error;
      serverLogger.error('[ZohoBooks] Error fetching contact', error.response?.data || error.message);
      return null;
    }
  }

  async getContactByName(name: string): Promise<any | null> {
    if (!this.config.refreshToken) {
      throw new ZohoError('Config Error', 'MISSING_REFRESH_TOKEN', 'ZOHO_REFRESH_TOKEN is not set');
    }

    try {
      const headers = await this.getHeaders();
      const response = await axios.get(`${this.baseUrl}/contacts`, {
        headers,
        params: { ...this.defaultParams, contact_name: name }
      });

      if (response.data.code === 0 && response.data.contacts.length > 0) {
        return response.data.contacts[0];
      }
      return null;
    } catch (error: any) {
      // Auth/config errors must propagate so callers can distinguish "not found" from "broken auth"
      if (error instanceof ZohoError) throw error;
      serverLogger.error('[ZohoBooks] Error fetching contact by name', error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Create a new contact in Zoho Books
   */
  async createContact(user: any): Promise<any> {
    if (!this.config.refreshToken) return null;

    try {
      const headers = await this.getHeaders();
      const contactData: any = {
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
        const response = await this.idempotentRetry(() =>
            axios.post(`${this.baseUrl}/contacts`, contactData, { headers, params: this.defaultParams })
        );

        if (response.data.code === 0) {
          return response.data.contact;
        }
        throw new Error(response.data.message);
      } catch (error: any) {
        const errorData = error.response?.data;
        const errorMessage = errorData?.message || error.message;

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

           const retryResponse = await this.idempotentRetry(() =>
               axios.post(`${this.baseUrl}/contacts`, fallbackData, { headers, params: this.defaultParams })
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
          const existing = await this.getContactByName(contactName);
          if (existing) {
            serverLogger.info(`[ZohoBooks] Found existing contact by name: ${existing.contact_id}`);
            return existing;
          }
        }

        serverLogger.error('[ZohoBooks] Error creating contact', errorData || error.message);
        throw error;
      }
    } catch (error: any) {
      serverLogger.error('[ZohoBooks] Outer Error creating contact', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Update an existing contact's details to match user profile
   */
  async updateContactDetails(contactId: string, user: any): Promise<boolean> {
    if (!this.config.refreshToken) return false;

    try {
      const headers = await this.getHeaders();
      
      // 1. Update the Main Contact (Organization/Display Name)
      const isGstValid = user.gstNumber && this.isValidGst(user.gstNumber);
      const cleanGst = isGstValid ? user.gstNumber.trim().replace(/\s/g, '').toUpperCase() : '';

      const updateData: any = {
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
      
      await this.idempotentRetry(() =>
          axios.put(`${this.baseUrl}/contacts/${contactId}`, updateData, { headers, params: this.defaultParams })
      );

      // 2. Update the Primary Contact Person (First/Last Name)
      // Zoho often uses the Contact Person's name for invoice "Bill To" sections.
      try {
        const contactPersons = await this.getContactPersons(contactId);
        const primaryPerson = contactPersons.find((p: any) => p.is_primary_contact);
        
        if (primaryPerson) {
          serverLogger.info(`[ZohoBooks] Updating primary contact person ${primaryPerson.contact_person_id} for contact ${contactId}`);
          await this.updateContactPerson(primaryPerson.contact_person_id, user);
        }
      } catch (personError: any) {
        serverLogger.warn(`[ZohoBooks] Failed to update contact person for ${contactId}, but main contact updated.`, personError.message);
      }

      return true;
    } catch (error: any) {
      serverLogger.error(`[ZohoBooks] Failed to update contact ${contactId}`, error.response?.data || error.message);
      return false; // Proceed anyway
    }
  }

  /**
   * Basic GSTIN validation (15 characters: 2 state code + 10 PAN + 1 entity + 1 blank + 1 check digit)
   */
  private isValidGst(gst: string): boolean {
    if (!gst) return false;
    const cleanGst = gst.trim().replace(/\s/g, '');
    const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    return cleanGst.length === 15 && gstRegex.test(cleanGst.toUpperCase());
  }

  /**
   * Get all contact persons for a contact
   */
  async getContactPersons(contactId: string): Promise<any[]> {
    if (!this.config.refreshToken) return [];
    
    try {
      const headers = await this.getHeaders();
      const response = await axios.get(`${this.baseUrl}/contacts/${contactId}/contactpersons`, { headers, params: this.defaultParams });
      
      if (response.data.code === 0) {
        return response.data.contact_persons;
      }
      return [];
    } catch (error: any) {
      serverLogger.error(`[ZohoBooks] Error fetching contact persons for ${contactId}`, error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Update a specific contact person
   */
  async updateContactPerson(contactPersonId: string, user: any): Promise<boolean> {
    if (!this.config.refreshToken) return false;

    try {
      const headers = await this.getHeaders();
      const personData = {
        first_name: user.firstName,
        last_name: user.lastName,
        email: user.email,
        phone: user.phone,
        mobile: user.phone
      };

      serverLogger.info(`[ZohoBooks] Updating contact person ${contactPersonId} with data:`, JSON.stringify(personData, null, 2));

      const response = await this.idempotentRetry(() =>
          axios.put(`${this.baseUrl}/contacts/contactpersons/${contactPersonId}`, personData, { headers, params: this.defaultParams })
      );

      return response.data.code === 0;
    } catch (error: any) {
      serverLogger.error(`[ZohoBooks] Error updating contact person ${contactPersonId}`, error.response?.data || error.message);
      return false;
    }
  }

  /**
   * Update an existing contact's GST status to Consumer
   * Use this as a fallback when GST validation blocks invoices
   */
  async updateContactToConsumer(contactId: string): Promise<boolean> {
    if (!this.config.refreshToken) return false;

    try {
      const headers = await this.getHeaders();
      const updateData = {
        gst_treatment: 'consumer',
        gst_no: '' // Clearing GST number
      };

      serverLogger.info(`[ZohoBooks] Forcing contact ${contactId} to consumer status`);
      
      const response = await this.idempotentRetry(() =>
          axios.put(`${this.baseUrl}/contacts/${contactId}`, updateData, { headers, params: this.defaultParams })
      );

      return response.data.code === 0;
    } catch (error: any) {
      serverLogger.error(`[ZohoBooks] Failed to update contact ${contactId} to consumer`, error.response?.data || error.message);
      return false;
    }
  }

  /**
   * Create an invoice and optionally apply payment
   */
  async createInvoice(order: any, user: any, items: any[], paymentMode: string = 'Razorpay', shouldApplyPayment: boolean = true): Promise<any> {
    if (!this.config.refreshToken) {
      throw new ZohoError('Config Error', 'MISSING_REFRESH_TOKEN', 'ZOHO_REFRESH_TOKEN environment variable is not set — Zoho Books integration is disabled');
    }

    try {
      // 🛡️ IDEMPOTENCY: Check if an invoice with this OrderID already exists in Zoho
      const orderId = order.orderId || (order as any).reference_number;
      if (orderId) {
        const existingInvoices = await this.getInvoicesByReferenceNumber(orderId);
        if (existingInvoices.length > 0) {
            serverLogger.info(`[ZohoBooks] DUPLICATE DETECTED: Invoice already exists in Zoho for Order ${orderId}. Skipping creation.`);
            return existingInvoices[0]; // Return the first matching invoice
        }
      }

      // 1. Get or Create Contact
      let contact = await this.getContactByEmail(user.email);
      if (!contact) {
        contact = await this.createContact(user);
      } else {
        // User might have updated details (e.g. re-signed up), sync changes to Zoho
        await this.updateContactDetails(contact.contact_id, user);
      }

      if (!contact) {
        throw new Error('Failed to identify customer in Zoho Books');
      }

      const customerState = contact.billing_address?.state || user.address?.state || '';
      const isInterState = customerState && customerState.toLowerCase() !== ZohoBooksService.ORG_STATE.toLowerCase();
      const taxId = isInterState ? ZohoBooksService.TAX_IDS.IGST18 : ZohoBooksService.TAX_IDS.GST18;

      const headers = await this.getHeaders();

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
        const rate = isTestHosting ? 1 : ZohoBooksService.roundAmount(item.price);
        const quantity = isTestHosting ? 1 : actualDuration;
        const startDate = order.createdAt ? new Date(order.createdAt) : new Date();
        const periodText = formatSubscriptionPeriod(startDate, actualDuration, item.periodUnit || (item.itemType === 'hosting' ? 'months' : 'years'));

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
        location_id: ZohoBooksService.LOCATION_ID,
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
        response = await this.idempotentRetry(() =>
            axios.post(`${this.baseUrl}/invoices`, invoiceData, {
                headers,
                params: { send: false, ...this.defaultParams }
            })
        );
      } catch (invoiceError: any) {
        const errorData = invoiceError.response?.data;
        const errorMessage = errorData?.message || invoiceError.message;

        // 🛡️ FALLBACK: If invoice creation fails due to GST issues, try to fix contact and retry once
        if (errorData?.code === 2 && errorMessage.toLowerCase().includes('gst')) {
            serverLogger.warn(`[ZohoBooks] Invoice GST error for ${user.email}. Attempting contact fix.`, errorMessage);
            
            const fixed = await this.updateContactToConsumer(contact.contact_id);
            if (fixed) {
                serverLogger.info(`[ZohoBooks] Contact fixed. Retrying invoice creation for ${orderId}...`);
                response = await this.idempotentRetry(() =>
                    axios.post(`${this.baseUrl}/invoices`, invoiceData, {
                        headers,
                        params: { send: false, ...this.defaultParams }
                    })
                );
            } else {
                throw invoiceError; // Fix failed, rethrow original
            }
        } 
        // 🛡️ FALLBACK: Tax ID mismatch (IGST vs CGST/SGST)
        else if (errorData?.code === 3032) {
            const isIntraState = taxId === ZohoBooksService.TAX_IDS.GST18;
            const newTaxId = isIntraState ? ZohoBooksService.TAX_IDS.IGST18 : ZohoBooksService.TAX_IDS.GST18;
            const taxTypeLabel = isIntraState ? "Inter-state" : "Intra-state";

            serverLogger.warn(`[ZohoBooks] Tax mismatch for ${user.email} (tried ${isIntraState ? 'Local' : 'Inter-state'}). Retrying with ${taxTypeLabel}...`);

            // Re-prepare line items with the swapped tax ID
            const swappedLineItems = invoiceData.line_items.map((li: any) => ({ ...li, tax_id: newTaxId }));
            const retryData = { ...invoiceData, line_items: swappedLineItems };

            response = await this.idempotentRetry(() =>
                axios.post(`${this.baseUrl}/invoices`, retryData, {
                    headers,
                    params: { send: false, ...this.defaultParams }
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
        await this.idempotentRetry(() =>
            axios.post(`${this.baseUrl}/invoices/${invoice.invoice_id}/status/sent`, {}, { headers, params: this.defaultParams })
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

          const paymentResponse = await this.idempotentRetry(() =>
              axios.post(`${this.baseUrl}/customerpayments`, paymentData, { headers, params: this.defaultParams })
          );
          
          if (paymentResponse.data.code === 0) {
             serverLogger.info(`[ZohoBooks] Payment recorded for invoice ${invoice.invoice_number}`);
          } else {
             serverLogger.warn(`[ZohoBooks] Failed to record payment: ${paymentResponse.data.message}`);
          }
        } catch (paymentError: any) {
          serverLogger.warn(`[ZohoBooks] Payment recording failed, but invoice was created:`, paymentError.response?.data || paymentError.message);
          // Do not throw, return invoice since it was successfully created
        }
      } else {
        const reason = invoice.total <= 0 ? "total is zero" : "shouldApplyPayment=false";
        serverLogger.info(`[ZohoBooks] Skipping payment recording for invoice ${invoice.invoice_number} (${reason})`);
      }

      return invoice;

    } catch (error: any) {
      const errorData = error.response?.data;
      if (errorData?.code === 103001) {
        serverLogger.error('[ZohoBooks] Invoice creation failed — Zoho Books subscription expired. Upgrade required.', errorData.message);
        throw new ZohoError('Subscription Expired', 'SUBSCRIPTION_EXPIRED', 'Zoho Books subscription has expired. Please renew to generate invoices.');
      }
      serverLogger.error('[ZohoBooks] Invoice creation failed', errorData || error.message);
      throw error;
    }
  }
  /**
   * Get invoices by Email
   */
  async getInvoicesByEmail(email: string): Promise<any[]> {
    if (!this.config.refreshToken) {
      serverLogger.warn('[ZohoBooks] Missing refresh token, cannot fetch invoices.');
      return [];
    }

    try {
      serverLogger.info(`[ZohoBooks] Fetching invoices for email: ${email}`);
      const contact = await this.getContactByEmail(email);
      if (!contact) {
        serverLogger.warn(`[ZohoBooks] Contact not found for email: ${email}`);
        return [];
      }

      serverLogger.info(`[ZohoBooks] Found contact: ${contact.contact_id} for email: ${email}`);

      const headers = await this.getHeaders();
      const response = await this.idempotentRetry(() => 
          axios.get(`${this.baseUrl}/invoices`, {
            headers,
            params: {
              customer_id: contact.contact_id,
              ...this.defaultParams,
              sort_column: 'date',
              sort_order: 'D'
            }
          })
      );

      if (response.data.code === 0) {
        serverLogger.info(`[ZohoBooks] Found ${response.data.invoices.length} invoices for ${email}`);
        
        // Sort by invoice_number DESC to ensure sequential order (e.g. INV-00014 before INV-00013)
        return response.data.invoices.sort((a: any, b: any) => 
            (b.invoice_number || "").localeCompare(a.invoice_number || "", undefined, { numeric: true, sensitivity: 'base' })
        );
      }
      serverLogger.warn(`[ZohoBooks] Failed to list invoices. Code: ${response.data.code}, Message: ${response.data.message}`);
      return [];
    } catch (error: any) {
      const errCode = error.response?.data?.code;
      const errMsg = error.response?.data?.message || error.message;

      serverLogger.error(`[ZohoBooks] Failed to fetch invoices: Code ${errCode}, Msg: ${errMsg}`);

      // PROBE: Check if we have global invoice read access
      if (errCode === 57) {
        try {
           serverLogger.info('[ZohoBooks] Probing global invoice access...');
           const headers = await this.getHeaders(); 
           const probeParams = {
             ...this.defaultParams,
             page: 1,
             per_page: 1
           };
           await axios.get(`${this.baseUrl}/invoices`, { headers, params: probeParams });
           serverLogger.warn('[ZohoBooks] PROBE SUCCESS: You HAVE access to invoices. The issue is likely with the specific Customer ID.');
        } catch (probeError: any) {
           serverLogger.error('[ZohoBooks] PROBE FAILED: You likely DO NOT have "ZohoBooks.invoices.READ" scope.', probeError.response?.data || probeError.message);
        }
      }

      return [];
    }
  }

  /**
   * Get Invoice PDF from Zoho Books
   */
  async getInvoicePdf(invoiceId: string): Promise<ArrayBuffer | null> {
    if (!this.config.refreshToken || !invoiceId) return null;

    try {
      const headers = await this.getHeaders();
      // Zoho Books API to get PDF: /invoices/{invoice_id}?accept=pdf
      const response = await this.idempotentRetry(() => 
          axios.get(`${this.baseUrl}/invoices/${invoiceId}`, {
            headers: {
                ...headers,
                'Accept': 'application/pdf'
            },
            responseType: 'arraybuffer',
            params: {
                accept: 'pdf',
                ...this.defaultParams
            }
          })
      );

      return response.data;
    } catch (error: any) {
      serverLogger.error('[ZohoBooks] Failed to fetch invoice PDF', error.response?.data || error.message);
      return null;
    }
  }
  /**
   * Get All Invoices (Admin)
   */
  async getAllInvoices(page = 1, perPage = 20): Promise<{ invoices: any[], page_context: any }> {
    if (!this.config.refreshToken) {
      serverLogger.warn('[ZohoBooks] Missing refresh token, cannot fetch all invoices.');
      return { invoices: [], page_context: {} };
    }

    try {
      const headers = await this.getHeaders();
      const response = await this.idempotentRetry(() => 
          axios.get(`${this.baseUrl}/invoices`, {
            headers,
            params: {
              ...this.defaultParams,
              page,
              per_page: perPage,
              sort_column: 'date',
              sort_order: 'D'
            }
          })
      );

      if (response.data.code === 0) {
        // Sort by invoice_number DESC to ensure sequential order
        const sortedInvoices = response.data.invoices.sort((a: any, b: any) => 
            (b.invoice_number || "").localeCompare(a.invoice_number || "", undefined, { numeric: true, sensitivity: 'base' })
        );

        return {
            invoices: sortedInvoices,
            page_context: response.data.page_context
        };
      }
      return { invoices: [], page_context: {} };
    } catch (error: any) {
      serverLogger.error('[ZohoBooks] Failed to fetch all invoices', error.response?.data || error.message);
      return { invoices: [], page_context: {} };
    }
  }
  /**
   * Create a Recurring Invoice Profile
   */
  async createRecurringInvoice(order: any, user: any, items: any[]): Promise<{ domainName: string, success: boolean, recurringInvoiceId?: string, error?: string }[]> {
    if (!this.config.refreshToken) return [];

    const results: { domainName: string, success: boolean, recurringInvoiceId?: string, error?: string }[] = [];

    try {
      // 1. Get or Create Contact
      let contact = await this.getContactByEmail(user.email);
      if (!contact) {
        contact = await this.createContact(user);
      } else {
        // User might have updated details (e.g. re-signed up), sync changes to Zoho
        await this.updateContactDetails(contact.contact_id, user);
      }

      if (!contact) {
        throw new Error('Failed to identify customer in Zoho Books for recurring invoice');
      }

      const headers = await this.getHeaders();
      
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
               location_id: ZohoBooksService.LOCATION_ID,
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
                       rate: ZohoBooksService.roundAmount(item.price),
                       quantity: 1
                   }
               ],
               notes: `Auto-generated recurring profile for Order: ${order.orderId}`
           };

           serverLogger.info(`[ZohoBooks] Creating Recurring Invoice for ${displayDomain}...`);
           
           // We create one profile per hosting item to allow independent cancellation
           const response = await this.idempotentRetry(() =>
               axios.post(`${this.baseUrl}/recurringinvoices`, recurringData, { headers, params: this.defaultParams })
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

  /**
   * Get Invoice by ID
   */
  async getInvoiceById(invoiceId: string): Promise<any | null> {
    if (!this.config.refreshToken || !invoiceId) return null;

    try {
      const headers = await this.getHeaders();
      const response = await this.idempotentRetry(() =>
          axios.get(`${this.baseUrl}/invoices/${invoiceId}`, { headers, params: this.defaultParams })
      );

      if (response.data.code === 0) {
        return response.data.invoice;
      }
      return null;
    } catch (error: any) {
      serverLogger.error('[ZohoBooks] Error fetching invoice by ID', error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Apply Payment to Invoice
   */
  async applyPaymentToInvoice(invoiceId: string, amount: number, paymentMode: string = 'Razorpay', referenceNumber: string): Promise<boolean> {
    if (!this.config.refreshToken || !invoiceId) return false;

    try {
      const invoice = await this.getInvoiceById(invoiceId);
      if (!invoice) {
        throw new Error(`Invoice ${invoiceId} not found`);
      }

      const headers = await this.getHeaders();
      
      const roundedAmount = ZohoBooksService.roundAmount(amount);
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

      const response = await this.idempotentRetry(() =>
          axios.post(`${this.baseUrl}/customerpayments`, paymentData, { headers, params: this.defaultParams })
      );

      return response.data.code === 0;
    } catch (error: any) {
      serverLogger.error('[ZohoBooks] Error applying payment to invoice', error.response?.data || error.message);
      return false;
    }
  }

  /**
   * Search for invoices by reference number (Order ID)
   */
  async getInvoicesByReferenceNumber(referenceNumber: string): Promise<any[]> {
    if (!this.config.refreshToken || !referenceNumber) return [];

    try {
      const headers = await this.getHeaders();
      const response = await this.idempotentRetry(() => 
          axios.get(`${this.baseUrl}/invoices`, {
            headers,
            params: {
              reference_number: referenceNumber,
              ...this.defaultParams
            }
          })
      );

      if (response.data.code === 0 && response.data.invoices) {
        return response.data.invoices;
      }
      return [];
    } catch (error: any) {
      serverLogger.error('[ZohoBooks] Failed to fetch invoices by reference number', error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Get primary organization details to check plan status
   */
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
  async createCreditNote(
    zohoInvoiceId: string,
    zohoContactId: string,
    refundId: string,
    refundAmountPaise: number,
    orderId: string
  ): Promise<any> {
    if (!this.config.refreshToken) {
      throw new ZohoError('Config Error', 'MISSING_REFRESH_TOKEN', 'ZOHO_REFRESH_TOKEN is not set');
    }

    const headers = await this.getHeaders();
    const amountRupees = ZohoBooksService.roundAmount(refundAmountPaise / 100);
    const today = new Date().toISOString().split('T')[0];

    const creditNotePayload = {
      customer_id: zohoContactId,
      location_id: ZohoBooksService.LOCATION_ID,
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

    const createResponse = await this.idempotentRetry(() =>
      axios.post(`${this.baseUrl}/creditnotes`, creditNotePayload, { headers, params: this.defaultParams })
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
    const applyResponse = await this.idempotentRetry(() =>
      axios.post(
        `${this.baseUrl}/creditnotes/${creditNote.creditnote_id}/invoices`,
        { invoices: [{ invoice_id: zohoInvoiceId, amount_applied: amountRupees }] },
        { headers, params: this.defaultParams }
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

  async getOrganizationDetails(): Promise<any | null> {
    if (!this.config.refreshToken) return null;

    try {
      const headers = await this.getHeaders();
      // Zoho Books API to list organizations
      const response = await this.idempotentRetry(() => 
          axios.get(`${this.baseUrl}/organizations`, { headers })
      );

      if (response.data.code === 0 && response.data.organizations) {
        // Find the organization matching our orgId, or fallback to the first one
        const org = response.data.organizations.find((o: any) => 
            String(o.organization_id) === String(this.config.orgId)
        ) || response.data.organizations[0];
        
        return org;
      }
      return null;
    } catch (error: any) {
      serverLogger.error('[ZohoBooks] Failed to fetch organization details', error.response?.data || error.message);
      return null;
    }
  }
}


