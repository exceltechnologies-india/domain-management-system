/**
 * ResellerClub — customer + contact management.
 */

import { AxiosError } from "axios";
import { ResellerClubResponse } from "@/lib/types";
import { serverLogger } from "@/lib/server-logger";
import { api } from "./client";

/**
 * Check if a customer exists in ResellerClub system and get their ID
 */
export async function getCustomerId(
  username: string
): Promise<{ status: string; customerId?: number; error?: string }> {
  const startTime = Date.now();
  serverLogger.info(
    `🔍 [PRODUCTION] Checking if ResellerClub customer exists: ${username}`
  );

  try {
    const response = await api.get("/api/customers/details.json", {
      params: {
        username: username,
      },
    });

    const responseTime = Date.now() - startTime;
    serverLogger.info(
      `✅ [PRODUCTION] Customer details fetched in ${responseTime}ms:`,
      {
        responseData: response.data,
        status: response.status,
      }
    );

    // If we get here, customer exists
    if (response.data && response.data.customerid) {
      return {
        status: "success",
        customerId: parseInt(response.data.customerid),
      };
    } else {
      return {
        status: "error",
        error: "Customer not found",
      };
    }
  } catch (error) {
    const responseTime = Date.now() - startTime;
    serverLogger.info(
      `ℹ️ [PRODUCTION] Customer check completed in ${responseTime}ms - Customer does not exist`
    );

    // If customer doesn't exist, ResellerClub returns an error
    // This is expected behavior, so we return "not found" status
    return {
      status: "not_found",
      error: "Customer does not exist",
    };
  }
}

/**
 * Create a customer in ResellerClub system
 */
export async function createCustomer(customerData: {
  username: string;
  passwd: string;
  name: string;
  company?: string;
  addressLine1: string;
  city: string;
  state: string;
  country: string;
  zipcode: string;
  phoneCc: string;
  phone: string;
  langPref?: string;
}): Promise<{ status: string; data?: unknown; error?: string }> {
  const startTime = Date.now();
  serverLogger.info(
    `🚀 [PRODUCTION] Creating ResellerClub customer: ${customerData.username}`
  );

  try {
    const response = await api.post("/api/customers/signup.json", null, {
      params: {
        username: customerData.username,
        passwd: customerData.passwd,
        name: customerData.name,
        company: customerData.company || customerData.name, // Use name as company if not provided
        "address-line-1": customerData.addressLine1,
        city: customerData.city,
        state: customerData.state,
        country: customerData.country,
        zipcode: customerData.zipcode,
        "phone-cc": customerData.phoneCc,
        phone: customerData.phone,
        "lang-pref": customerData.langPref || "en",
        "reseller-id":
          process.env.RESELLERCLUB_RESELLER_ID || process.env.RESELLERCLUB_ID, // Add reseller ID
      },
    });

    const responseTime = Date.now() - startTime;
    serverLogger.info(
      `✅ [PRODUCTION] Customer created successfully in ${responseTime}ms:`,
      {
        responseData: response.data,
        status: response.status,
      }
    );

    return {
      status: "success",
      data: response.data,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    serverLogger.error(
      `❌ [PRODUCTION] Customer creation failed after ${responseTime}ms:`,
      {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
        axiosError:
          error instanceof AxiosError
            ? {
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                code: error.code,
              }
            : undefined,
        customerData: {
          username: customerData.username,
          name: customerData.name,
        },
      }
    );

    return {
      status: "error",
      error:
        error instanceof AxiosError
          ? error.response?.data?.message || error.message
          : "Unknown error occurred",
    };
  }
}

/**
 * Modify/Update customer details in ResellerClub system
 *
 * This method updates an existing customer's profile information in ResellerClub.
 * Used to sync user profile changes from the application to ResellerClub.
 *
 * @param customerData - Object containing username (email) and fields to update
 * @returns Promise with status and response data
 */
export async function modifyCustomer(customerData: {
  username: string;
  customerId: number;
  name?: string;
  company?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  country?: string;
  zipcode?: string;
  phoneCc?: string;
  phone?: string;
}): Promise<{ status: string; data?: unknown; error?: string }> {
  const startTime = Date.now();
  serverLogger.info(
    `🔄 [PRODUCTION] Modifying ResellerClub customer: ${customerData.username} (ID: ${customerData.customerId})`
  );


  try {
    // Build params object with only provided fields
    // ResellerClub requires BOTH username and customer-id, plus lang-pref
    const params: Record<string, string | number | undefined> = {
      username: customerData.username,
      "customer-id": customerData.customerId,
      "lang-pref": "en", // Required by ResellerClub
    };

    if (customerData.name) params.name = customerData.name;
    if (customerData.company) params.company = customerData.company;
    if (customerData.addressLine1) params["address-line-1"] = customerData.addressLine1;
    if (customerData.city) params.city = customerData.city;
    if (customerData.state) params.state = customerData.state;
    if (customerData.country) params.country = customerData.country;
    if (customerData.zipcode) params.zipcode = customerData.zipcode;
    if (customerData.phoneCc) params["phone-cc"] = customerData.phoneCc;
    if (customerData.phone) params.phone = customerData.phone;

    const response = await api.post("/api/customers/modify.json", null, {
      params,
    });

    const responseTime = Date.now() - startTime;
    serverLogger.info(
      `✅ [PRODUCTION] Customer modified successfully in ${responseTime}ms:`,
      {
        username: customerData.username,
        responseData: response.data,
        status: response.status,
      }
    );

    return {
      status: "success",
      data: response.data,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    serverLogger.error(
      `❌ [PRODUCTION] Customer modification failed after ${responseTime}ms:`,
      {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
        axiosError:
          error instanceof AxiosError
            ? {
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                code: error.code,
              }
            : undefined,
        customerData: {
          username: customerData.username,
        },
      }
    );

    return {
      status: "error",
      error:
        error instanceof AxiosError
          ? error.response?.data?.message || error.message
          : "Unknown error occurred",
    };
  }
}

/**
 * Modify an existing contact in ResellerClub system.
 *
 * Contact records (not customer records) are what RC attaches to each
 * domain as the registrant/admin/tech/billing WHOIS contact. Updating the
 * customer alone does NOT update the contact already linked to a domain —
 * this method is the missing piece for keeping WHOIS data accurate after
 * a user later corrects their profile.
 *
 * @returns { status: "success" | "error", data?, error? }
 */
export async function modifyContact(contactData: {
  contactId: number;
  name?: string;
  company?: string;
  email?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  country?: string;
  zipcode?: string;
  phoneCc?: string;
  phone?: string;
}): Promise<ResellerClubResponse> {
  const startTime = Date.now();
  serverLogger.info(
    `🔄 [PRODUCTION] Modifying ResellerClub contact (ID: ${contactData.contactId})`
  );

  try {
    const params: Record<string, string | number | undefined> = {
      "contact-id": contactData.contactId,
    };

    if (contactData.name) params.name = contactData.name;
    if (contactData.company) params.company = contactData.company;
    if (contactData.email) params.email = contactData.email;
    if (contactData.addressLine1) params["address-line-1"] = contactData.addressLine1;
    if (contactData.city) params.city = contactData.city;
    if (contactData.state) params.state = contactData.state;
    if (contactData.country) params.country = contactData.country;
    if (contactData.zipcode) params.zipcode = contactData.zipcode;
    if (contactData.phoneCc) params["phone-cc"] = contactData.phoneCc;
    if (contactData.phone) params.phone = contactData.phone;

    const response = await api.post("/api/contacts/modify.json", null, { params });

    const responseTime = Date.now() - startTime;
    serverLogger.info(
      `✅ [PRODUCTION] Contact modified successfully in ${responseTime}ms:`,
      {
        contactId: contactData.contactId,
        responseData: response.data,
        status: response.status,
      }
    );

    return {
      status: "success",
      data: response.data,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    serverLogger.error(
      `❌ [PRODUCTION] Contact modification failed after ${responseTime}ms:`,
      {
        error: error instanceof Error ? error.message : "Unknown error",
        axiosError:
          error instanceof AxiosError
            ? {
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                code: error.code,
              }
            : undefined,
        contactId: contactData.contactId,
      }
    );

    return {
      status: "error",
      message:
        error instanceof AxiosError
          ? error.response?.data?.message || error.message
          : "Unknown error occurred",
    };
  }
}

/**
 * Create a contact in ResellerClub system
 */
export async function createContact(contactData: {
  customerId: number;
  name: string;
  company?: string;
  email: string;
  addressLine1: string;
  city: string;
  state: string;
  country: string;
  zipcode: string;
  phoneCc: string;
  phone: string;
  type: "Contact" | "CaDomain" | "IrtContact";
}): Promise<{ status: string; data?: unknown; error?: string }> {
  const startTime = Date.now();
  serverLogger.info(
    `🚀 [PRODUCTION] Creating ResellerClub contact: ${contactData.name} (${contactData.email})`
  );

  try {
    const response = await api.post("/api/contacts/add.json", null, {
      params: {
        "customer-id": contactData.customerId,
        name: contactData.name,
        company: contactData.company || contactData.name, // Use name as company if not provided
        email: contactData.email,
        "address-line-1": contactData.addressLine1,
        city: contactData.city,
        state: contactData.state,
        country: contactData.country,
        zipcode: contactData.zipcode,
        "phone-cc": contactData.phoneCc,
        phone: contactData.phone,
        type: contactData.type,
        "reseller-id":
          process.env.RESELLERCLUB_RESELLER_ID || process.env.RESELLERCLUB_ID, // Add reseller ID
      },
    });

    const responseTime = Date.now() - startTime;
    serverLogger.info(
      `✅ [PRODUCTION] Contact created successfully in ${responseTime}ms:`,
      {
        responseData: response.data,
        status: response.status,
      }
    );

    return {
      status: "success",
      data: response.data,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    serverLogger.error(
      `❌ [PRODUCTION] Contact creation failed after ${responseTime}ms:`,
      {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
        axiosError:
          error instanceof AxiosError
            ? {
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                code: error.code,
              }
            : undefined,
        contactData: {
          name: contactData.name,
          email: contactData.email,
          customerId: contactData.customerId,
        },
      }
    );

    return {
      status: "error",
      error:
        error instanceof AxiosError
          ? error.response?.data?.message || error.message
          : "Unknown error occurred",
    };
  }
}

/**
 * Get or create a ResellerClub customer and contact for a user
 */
export async function getOrCreateCustomerAndContact(userData: {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  phoneCc?: string;
  companyName?: string;
  address?: {
    line1: string;
    city: string;
    state: string;
    country: string;
    zipcode: string;
  };
}): Promise<{
  status: string;
  customerId?: number;
  contactId?: number;
  error?: string;
}> {
  serverLogger.info(
    `🔍 [PRODUCTION] Getting or creating ResellerClub customer and contact for user: ${userData.email}`
  );

  try {
    // First, check if customer already exists
    const existingCustomer = await getCustomerId(
      userData.email
    );

    let customerId: number;

    if (
      existingCustomer.status === "success" &&
      existingCustomer.customerId
    ) {
      // Customer already exists, use their ID
      customerId = existingCustomer.customerId;
      serverLogger.info(
        `✅ [PRODUCTION] Found existing ResellerClub customer ${customerId} for user: ${userData.email}`
      );
    } else {
      // Customer doesn't exist, create a new one
      serverLogger.info(
        `🆕 [PRODUCTION] Customer not found, creating new ResellerClub customer for: ${userData.email}`
      );

      // Generate ResellerClub-compliant password (8-15 alphanumeric characters)
      const tempPassword = `Temp${Math.random()
        .toString(36)
        .substring(2, 10)}`;

      // Clean phone number (remove spaces and non-digits)
      const cleanPhone = userData.phone?.replace(/\D/g, "") || "0000000000";

      serverLogger.info(`🔧 [PRODUCTION] Generated ResellerClub credentials:`, {
        password: tempPassword,
        passwordLength: tempPassword.length,
        originalPhone: userData.phone,
        cleanPhone: cleanPhone,
        phoneCc: userData.phoneCc?.replace("+", "") || "91",
      });

      // Create customer
      const customerResult = await createCustomer({
        username: userData.email,
        passwd: tempPassword, // Generate ResellerClub-compliant password
        name: `${userData.firstName} ${userData.lastName}`,
        company:
          userData.companyName ||
          `${userData.firstName} ${userData.lastName}`, // Use companyName from user data
        addressLine1: userData.address?.line1 || "Default Address",
        city: userData.address?.city || "Default City",
        state: userData.address?.state || "Default State",
        country: userData.address?.country || "IN",
        zipcode: userData.address?.zipcode || "000000",
        phoneCc: userData.phoneCc?.replace("+", "") || "91", // Use user's phone country code or default to India
        phone: cleanPhone, // Clean phone number without spaces
        langPref: "en",
      });

      if (customerResult.status !== "success" || !customerResult.data) {
        serverLogger.error(
          `❌ [PRODUCTION] Failed to create ResellerClub customer for user ${userData.email}:`,
          customerResult.error
        );
        return {
          status: "error",
          error: `Failed to create customer: ${customerResult.error}`,
        };
      }

      // ResellerClub returns customer ID directly as a number
      customerId = parseInt(String(customerResult.data));
      serverLogger.info(
        `✅ [PRODUCTION] Created ResellerClub customer ${customerId} for user: ${userData.email}`
      );
    }

    // Clean phone number for contact creation (remove spaces and non-digits)
    const cleanPhone = userData.phone?.replace(/\D/g, "") || "0000000000";

    // Create contact
    const contactResult = await createContact({
      customerId: customerId,
      name: `${userData.firstName} ${userData.lastName}`,
      company:
        userData.companyName || `${userData.firstName} ${userData.lastName}`, // Use companyName from user data
      email: userData.email,
      addressLine1: userData.address?.line1 || "Default Address",
      city: userData.address?.city || "Default City",
      state: userData.address?.state || "Default State",
      country: userData.address?.country || "IN",
      zipcode: userData.address?.zipcode || "000000",
      phoneCc: userData.phoneCc?.replace("+", "") || "91", // Use user's phone country code or default to India
      phone: cleanPhone, // Use cleaned phone number without spaces
      type: "Contact",
    });

    if (contactResult.status !== "success" || !contactResult.data) {
      serverLogger.error(
        `❌ [PRODUCTION] Failed to create ResellerClub contact for user ${userData.email}:`,
        contactResult.error
      );
      return {
        status: "error",
        error: `Failed to create contact: ${contactResult.error}`,
      };
    }

    // ResellerClub returns contact ID directly as a number
    const contactId = parseInt(String(contactResult.data));
    serverLogger.info(
      `✅ [PRODUCTION] Created ResellerClub contact ${contactId} for user: ${userData.email}`
    );

    // Caller (the payment provisioner) persists customerId + contactId on
    // the user document via setUserResellerClubIds() — kept out of this
    // module so the wrapper stays User-model-agnostic.

    return {
      status: "success",
      customerId: customerId,
      contactId: contactId,
    };
  } catch (error) {
    serverLogger.error(
      `❌ [PRODUCTION] Error in getOrCreateCustomerAndContact for user ${userData.email}:`,
      error
    );
    return {
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Get customer details
 */
export async function getCustomerDetails(
  username: string
): Promise<ResellerClubResponse> {
  try {
    const response = await api.get("/api/customers/details.json", {
      params: {
        username: username,
      },
    });

    return {
      status: "success",
      data: response.data,
    };
  } catch (error) {
    serverLogger.error("ResellerClub customer details error:", error);
    return {
      status: "error",
      message: "Failed to get customer details",
    };
  }
}

/**
 * Get all domains for a customer from ResellerClub
 *
 * Fetches all domain orders associated with a customer account.
 * Used for syncing existing domains into the application.
 *
 * @param customerId - The ResellerClub customer ID
 * @returns Promise with domain list or error
 */
export async function getCustomerDomains(
  customerId: number
): Promise<ResellerClubResponse> {
  const startTime = Date.now();
  serverLogger.info(
    `🔍 [PRODUCTION] Fetching domains for customer ID: ${customerId}`
  );

  try {
    const response = await api.get("/api/domains/search.json", {
      params: {
        "customer-id": customerId,
        "no-of-records": 500, // Fetch up to 500 domains
        "page-no": 1,
      },
    });

    const responseTime = Date.now() - startTime;
    serverLogger.info(
      `✅ [PRODUCTION] Customer domains fetched in ${responseTime}ms:`,
      {
        customerId,
        domainCount: Object.keys(response.data || {}).length,
      }
    );

    return {
      status: "success",
      data: response.data,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    serverLogger.error(
      `❌ [PRODUCTION] Failed to fetch customer domains after ${responseTime}ms:`,
      error
    );
    return {
      status: "error",
      message: "Failed to fetch customer domains",
    };
  }
}
