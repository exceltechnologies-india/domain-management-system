/**
 * Zoho Books API Integration — backwards-compatible barrel.
 *
 * The class itself owns the singleton, auth state (access token, refresh,
 * subscription-expired tracking), and a handful of pure helpers. Every
 * high-level API call delegates to a function in `./zohobooks/*` which
 * receives the singleton as `self` and reads auth state via the `_`-prefixed
 * accessors below.
 *
 * Submodules:
 * - ./zohobooks/contacts      contact + contact-person CRUD
 * - ./zohobooks/invoices      invoice CRUD, payments, lookups, PDF
 * - ./zohobooks/recurring     recurring invoice profiles
 * - ./zohobooks/credit-notes  credit notes (refunds)
 * - ./zohobooks/org           organization details
 */

import axios from 'axios';
import { serverLogger } from './server-logger';
import type {
  ZohoContact,
  ZohoContactPerson,
  ZohoInvoice,
  ZohoOrderInput,
  ZohoOrderItemInput,
  ZohoOrganization,
  ZohoUserInput,
} from './zohobooks/types';
import { unwrapZohoError } from './zohobooks/types';

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
        public details: unknown
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
      } catch (e) {
        serverLogger.warn("[ZohoBooks] Could not persist subscription expiry to DB", (e as Error)?.message);
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
      } catch (e) {
        serverLogger.warn("[ZohoBooks] Could not clear subscription expiry from DB", (e as Error)?.message);
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
    } catch (error) {
      const unwrapped = unwrapZohoError(error);
      const errorMessage = (unwrapped.data as { error?: string } | undefined)?.error || unwrapped.message;
      serverLogger.error('[ZohoBooks] Failed to refresh token', errorMessage);
       // Throw a specific error so we can catch it specifically if needed
       throw new ZohoError('Auth Failed', 'AUTH_ERROR', errorMessage);
    }
  }

  private async idempotentRetry<T>(operation: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
      let lastError: unknown;
      for (let i = 0; i < retries; i++) {
          try {
              return await operation();
          } catch (error) {
              lastError = error;
              const unwrapped = unwrapZohoError(error);
              // Track subscription expiry so the health check can surface it
              // without needing a write-level probe call.
              if (unwrapped.data?.code === 103001 && !this._subscriptionExpired) {
                  this._subscriptionExpired = true;
                  this.persistSubscriptionExpiredToDB();
              }
              // Check if retryable: Network errors, 5xx, or 429
              const status = unwrapped.status;
              const isRetryable = !status || status >= 500 || status === 429;

              if (!isRetryable) {
                  throw error; // Don't retry validation or auth errors
              }

              serverLogger.warn(`[ZohoBooks] Transient error (Attempt ${i + 1}/${retries}), retrying...`, unwrapped.message);
              await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i))); // Exponential backoff
          }
      }
      throw lastError;
  }

  private async getHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
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
   * Basic GSTIN validation (15 characters: 2 state code + 10 PAN + 1 entity + 1 blank + 1 check digit)
   */
  private isValidGst(gst: string): boolean {
    if (!gst) return false;
    const cleanGst = gst.trim().replace(/\s/g, '');
    const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    return cleanGst.length === 15 && gstRegex.test(cleanGst.toUpperCase());
  }

  // ───── Internal accessors used by topical submodules ─────
  // Prefixed with `_` so they're visible-but-discouraged from external use.
  // Keeping them as methods/getters (not private) lets the topical files
  // read shared state without breaking the public API surface.

  /** @internal */ public _hasRefreshToken(): boolean {
    return !!this.config.refreshToken;
  }
  /** @internal */ public get _baseUrl(): string { return this.baseUrl; }
  /** @internal */ public get _orgId(): string | undefined { return this.config.orgId; }
  /** @internal */ public get _defaultParams(): Record<string, string> { return this.defaultParams; }
  /** @internal */ public _getHeaders() { return this.getHeaders(); }
  /** @internal */ public _idempotentRetry<T>(op: () => Promise<T>, retries?: number, delay?: number) {
    return this.idempotentRetry(op, retries, delay);
  }
  /** @internal */ public _isValidGst(gst: string): boolean { return this.isValidGst(gst); }
  /** @internal */ public get _TAX_IDS() { return ZohoBooksService.TAX_IDS; }
  /** @internal */ public get _LOCATION_ID(): string { return ZohoBooksService.LOCATION_ID; }
  /** @internal */ public get _ORG_STATE(): string { return ZohoBooksService.ORG_STATE; }
  /** @internal */ public _roundAmount(value: number): number { return ZohoBooksService.roundAmount(value); }

  // ───── Public delegates ─────
  // Each method preserves its original signature; the body delegates to a
  // topical submodule. Dynamic imports break the circular dependency
  // (submodules import `ZohoBooksService` for the `self: ZohoBooksService`
  // parameter type).

  /**
   * Search for a contact by email
   */
  async getContactByEmail(email: string): Promise<ZohoContact | null> {
    const { getContactByEmail } = await import('./zohobooks/contacts');
    return getContactByEmail(this, email);
  }

  async getContactByName(name: string): Promise<ZohoContact | null> {
    const { getContactByName } = await import('./zohobooks/contacts');
    return getContactByName(this, name);
  }

  /**
   * Create a new contact in Zoho Books
   */
  async createContact(user: ZohoUserInput): Promise<ZohoContact | null> {
    const { createContact } = await import('./zohobooks/contacts');
    return createContact(this, user);
  }

  /**
   * Update an existing contact's details to match user profile
   */
  async updateContactDetails(contactId: string, user: ZohoUserInput): Promise<boolean> {
    const { updateContactDetails } = await import('./zohobooks/contacts');
    return updateContactDetails(this, contactId, user);
  }

  /**
   * Get all contact persons for a contact
   */
  async getContactPersons(contactId: string): Promise<ZohoContactPerson[]> {
    const { getContactPersons } = await import('./zohobooks/contacts');
    return getContactPersons(this, contactId);
  }

  /**
   * Update a specific contact person
   */
  async updateContactPerson(contactPersonId: string, user: ZohoUserInput): Promise<boolean> {
    const { updateContactPerson } = await import('./zohobooks/contacts');
    return updateContactPerson(this, contactPersonId, user);
  }

  /**
   * Update an existing contact's GST status to Consumer
   * Use this as a fallback when GST validation blocks invoices
   */
  async updateContactToConsumer(contactId: string): Promise<boolean> {
    const { updateContactToConsumer } = await import('./zohobooks/contacts');
    return updateContactToConsumer(this, contactId);
  }

  /**
   * Create an invoice and optionally apply payment
   */
  async createInvoice(
    order: ZohoOrderInput,
    user: ZohoUserInput,
    items: ZohoOrderItemInput[],
    paymentMode: string = 'Razorpay',
    shouldApplyPayment: boolean = true,
  ): Promise<ZohoInvoice | null> {
    const { createInvoice } = await import('./zohobooks/invoices');
    return createInvoice(this, order, user, items, paymentMode, shouldApplyPayment);
  }

  /**
   * Get invoices by Email
   */
  async getInvoicesByEmail(email: string): Promise<ZohoInvoice[]> {
    const { getInvoicesByEmail } = await import('./zohobooks/invoices');
    return getInvoicesByEmail(this, email);
  }

  /**
   * Get Invoice PDF from Zoho Books
   */
  async getInvoicePdf(invoiceId: string): Promise<ArrayBuffer | null> {
    const { getInvoicePdf } = await import('./zohobooks/invoices');
    return getInvoicePdf(this, invoiceId);
  }

  /**
   * Get All Invoices (Admin)
   */
  async getAllInvoices(
    page = 1,
    perPage = 20,
  ): Promise<{ invoices: ZohoInvoice[]; page_context: Record<string, unknown> }> {
    const { getAllInvoices } = await import('./zohobooks/invoices');
    return getAllInvoices(this, page, perPage);
  }

  /**
   * Create a Recurring Invoice Profile
   */
  async createRecurringInvoice(
    order: ZohoOrderInput,
    user: ZohoUserInput,
    items: ZohoOrderItemInput[],
  ): Promise<{ domainName: string, success: boolean, recurringInvoiceId?: string, error?: string }[]> {
    const { createRecurringInvoice } = await import('./zohobooks/recurring');
    return createRecurringInvoice(this, order, user, items);
  }

  /**
   * Get Invoice by ID
   */
  async getInvoiceById(invoiceId: string): Promise<ZohoInvoice | null> {
    const { getInvoiceById } = await import('./zohobooks/invoices');
    return getInvoiceById(this, invoiceId);
  }

  /**
   * Apply Payment to Invoice
   */
  async applyPaymentToInvoice(invoiceId: string, amount: number, paymentMode: string = 'Razorpay', referenceNumber: string): Promise<boolean> {
    const { applyPaymentToInvoice } = await import('./zohobooks/invoices');
    return applyPaymentToInvoice(this, invoiceId, amount, paymentMode, referenceNumber);
  }

  /**
   * Search for invoices by reference number (Order ID)
   */
  async getInvoicesByReferenceNumber(referenceNumber: string): Promise<ZohoInvoice[]> {
    const { getInvoicesByReferenceNumber } = await import('./zohobooks/invoices');
    return getInvoicesByReferenceNumber(this, referenceNumber);
  }

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
  ): Promise<{ creditnote_id: string; [k: string]: unknown }> {
    const { createCreditNote } = await import('./zohobooks/credit-notes');
    return createCreditNote(this, zohoInvoiceId, zohoContactId, refundId, refundAmountPaise, orderId);
  }

  async getOrganizationDetails(): Promise<ZohoOrganization | null> {
    const { getOrganizationDetails } = await import('./zohobooks/org');
    return getOrganizationDetails(this);
  }
}
