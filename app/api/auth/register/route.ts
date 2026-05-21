import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import User from "@/models/User";
import { getUserByEmail } from "@/lib/services/users";
import { EmailService } from "@/lib/email";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import { Schemas } from "@/lib/validation";
import { RecaptchaServer } from "@/lib/recaptcha";
import { SecurityValidator } from "@/lib/security";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import crypto from "crypto";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 1 - CSRF Protection
     * Verifies that the request originated from our authorized domain.
     */
    const csrfCheck = SecurityValidator.validateCSRF(request);
    if (!csrfCheck.isValid) {
      return secureErrorResponse(csrfCheck.error || "CSRF Validation Failed", 403, "CSRF_ERROR");
    }

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 2 - Rate Limiting
     * Mitigation against automated account creation and brute-force registration.
     */
    const rateLimit = await rateLimiters.register.isAllowed(request);
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit, {
        limit: 5,
        message: "Too many registration attempts. Please try again later.",
      });
    }

    const body = await request.json();
    
    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 3 - Schema Validation & Sanitization
     * Uses Zod to enforce strict data types and structure.
     * defense: prevents mass assignment by using .strict() in the schema.
     */
    const result = Schemas.registration.safeParse(body);
    if (!result.success) {
      return secureErrorResponse("Invalid registration data", 400, "VALIDATION_ERROR", result.error.format());
    }

    const {
      email,
      password,
      firstName,
      lastName,
      phone,
      phoneCc,
      companyName,
      gstNumber,
      address,
      recaptchaToken,
    } = result.data;

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 4 - Human Verification (reCAPTCHA)
     * Verifies that the user is not a bot.
     */
    const clientIP = request.headers.get("x-forwarded-for")?.split(",")[0] ||
                     request.headers.get("x-real-ip") ||
                     "unknown";
    if (recaptchaToken) {
      const recaptchaResult = await RecaptchaServer.verifyToken(
        recaptchaToken,
        clientIP
      );
  
      if (!recaptchaResult.success) {
        return secureErrorResponse("Security verification failed. Please try again.", 403, "SECURITY_CHECK_FAILED");
      }
    }

    await connectDB();

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 5 - Business Logic Guard
     * Prevent registration of existing accounts.
     */
    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return secureErrorResponse(
        "An account with this email already exists", 
        400, 
        "USER_EXISTS", 
        { email: { _errors: ["An account with this email already exists"] } }
      );
    }

    // Generate activation token for email verification
    const activationToken = crypto.randomBytes(32).toString("hex");
    const activationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    /**
     * Creation: Only use whitelisted fields from the Zod result.
     * Password is automatically hashed by the User model's pre-save hook.
     */
    // profileCompleted is false when registering with minimal fields (email+password).
    // Users are prompted to complete their profile (phone, address, etc.) before checkout.
    const hasFullProfile = !!(phone && address?.line1 && address?.city);
    const user = new User({
      email,
      password,
      firstName,
      lastName,
      ...(phone ? { phone } : {}),
      ...(phoneCc ? { phoneCc } : {}),
      ...(companyName ? { companyName } : {}),
      ...(gstNumber ? { gstNumber } : {}),
      ...(address ? { address } : {}),
      role: "user", // Strict enforcement of default role
      isActivated: false,
      activationToken,
      activationTokenExpiry,
      provider: "credentials",
      profileCompleted: hasFullProfile,
    });

    await user.save();

    // Trigger activation email asynchronously
    EmailService.sendActivationEmail(
      user.email,
      `${user.firstName} ${user.lastName}`,
      activationToken
    ).catch((error) => {
      serverLogger.error("[REGISTRATION] Activation email failed:", error);
    });

    // Synchronize to external providers asynchronously
    void (async () => {
      try {
        const { ResellerClubAPI } = await import("@/lib/resellerclub");
        const { ZohoBooksService } = await import("@/lib/zohobooks");
        
        // 1. ResellerClub Sync
        const rcLookup = await ResellerClubAPI.getCustomerId(user.email);
        if (rcLookup.status === "success" && rcLookup.customerId) {
          await ResellerClubAPI.modifyCustomer({
            username: user.email,
            customerId: rcLookup.customerId,
            name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
            company: user.companyName,
            addressLine1: user.address?.line1,
            city: user.address?.city,
            state: user.address?.state,
            country: user.address?.country,
            zipcode: user.address?.zipcode,
            phoneCc: user.phoneCc?.replace(/\+/g, ''),
            phone: user.phone,
          });
          user.resellerClubCustomerId = rcLookup.customerId;
          await user.save();
        } else {
          // Try to create customer
          try {
            const customerResult = await ResellerClubAPI.createCustomer({
              username: user.email,
              passwd: crypto.randomBytes(8).toString('hex') + 'Aa1!', // Provide a random strong password
              name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Customer',
              company: user.companyName || 'N/A',
              addressLine1: user.address?.line1 || 'N/A',
              city: user.address?.city || 'N/A',
              state: user.address?.state || 'N/A',
              country: user.address?.country || 'IN',
              zipcode: user.address?.zipcode || '000000',
              phoneCc: user.phoneCc?.replace(/\+/g, '') || '91',
              phone: user.phone || '0000000000',
              langPref: 'en'
            });
            if (customerResult.status === "success" && customerResult.data) {
              user.resellerClubCustomerId = customerResult.data as number;
              await user.save();
            }
          } catch (e) {
            serverLogger.error("[REGISTRATION] RC Create Customer Error:", e);
          }
        }

        // 2. Zoho Books Sync
        const zohoService = ZohoBooksService.getInstance();
        const zohoContact = await zohoService.getContactByEmail(user.email);
        if (zohoContact) {
            await zohoService.updateContactDetails(zohoContact.contact_id, user);
        } else {
            await zohoService.createContact(user);
        }
      } catch (err) {
        serverLogger.error("[REGISTRATION] External provider sync error:", err);
      }
    })();

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 6 - Secure Reponse
     * Data Minimization: Return only essential fields to prevent info leakage.
     */
    return secureJsonResponse({
      message: "User created successfully. Please check your email to activate your account.",
      requiresActivation: true,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        isActivated: false,
        profileCompleted: user.profileCompleted,
        provider: "credentials",
      },
    }, 201);
  } catch (error) {
    // secureErrorResponse handles masking and logging internally
    return secureErrorResponse("Registration failed", 500, "SERVER_ERROR", error);
  }
}
