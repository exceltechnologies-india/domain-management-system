import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import { AuthService } from "@/lib/auth";
import { ResellerClubAPI } from "@/lib/resellerclub";
import { Schemas } from "@/lib/validation";
import { getUserWithPassword } from "@/lib/services/users";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

interface ProfileCompletionShape {
  whatsappNumber?: string;
  phone?: string;
  phoneCc?: string;
  address?: {
    line1?: string;
    city?: string;
    state?: string;
    country?: string;
    zipcode?: string;
  };
}

function checkProfileCompletion(user: ProfileCompletionShape): boolean {
  const hasWhatsApp = user.whatsappNumber && user.whatsappNumber.trim() !== "";
  const hasPhone = user.phone && user.phone.trim() !== "";
  const hasPhoneCc = user.phoneCc && user.phoneCc.trim() !== "";
  const hasAddress = user.address?.line1 && user.address.line1.trim() !== "";
  const hasCity = user.address?.city && user.address.city.trim() !== "";
  const hasState = user.address?.state && user.address.state.trim() !== "";
  const hasCountry = user.address?.country && user.address.country.trim() !== "";
  const hasZipcode = user.address?.zipcode && user.address.zipcode.trim() !== "";

  return !!(hasWhatsApp && hasPhone && hasPhoneCc && hasAddress && hasCity && hasState && hasCountry && hasZipcode);
}

export async function GET(request: NextRequest) {
  try {
    await connectDB();

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 1 - Authorization
     * Ensures only the owner of the session can access their settings.
     */
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    // Sync ResellerClub ID if missing (Operational side-effect)
    if (!user.resellerClubCustomerId) {
      try {
        const customerLookup = await ResellerClubAPI.getCustomerId(user.email);
        if (customerLookup.status === "success" && customerLookup.customerId) {
          user.resellerClubCustomerId = customerLookup.customerId;
          await user.save();
        }
      } catch (error) {
        serverLogger.error("RC Lookup Error:", error);
      }
    }

    // Load ResellerClub data if available (Operational side-effect)
    if (user.resellerClubCustomerId) {
      try {
        const rcResult = await ResellerClubAPI.getCustomerDetails(user.email);
        if (rcResult.status === "success" && rcResult.data) {
          let updated = false;
          const rcData = rcResult.data;

          if (rcData.name) {
            const [first, ...rest] = rcData.name.split(" ");
            const last = rest.join(" ");
            if (first && !user.firstName) { user.firstName = first; updated = true; }
            if (last && !user.lastName) { user.lastName = last; updated = true; }
          }
          if (rcData.company && !user.companyName) { user.companyName = rcData.company; updated = true; }
          if (rcData.telnocc && !user.phoneCc) { user.phoneCc = rcData.telnocc; updated = true; }
          if (rcData.telno && !user.phone) { user.phone = rcData.telno; updated = true; }

          if (!user.address) user.address = { line1: '', city: '', state: '', country: '', zipcode: '' };
          if (rcData.address1 && !user.address.line1) { user.address.line1 = rcData.address1; updated = true; }
          if (rcData.city && !user.address.city) { user.address.city = rcData.city; updated = true; }
          if (rcData.state && !user.address.state) { user.address.state = rcData.state; updated = true; }
          if (rcData.country && !user.address.country) { user.address.country = rcData.country; updated = true; }
          if (rcData.zip && !user.address.zipcode) { user.address.zipcode = rcData.zip; updated = true; }

          if (updated) await user.save();
        }
      } catch (error) {
        serverLogger.error("RC Sync Error:", error);
      }
    }

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 2 - Data Minimization
     * Explicitly whitelist fields to return. 
     * defense: prevents leaking sensitive fields like 'password' or 'resetToken'.
     */
    return secureJsonResponse({
      profile: {
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone || "",
        phoneCc: user.phoneCc || "+91",
        whatsappNumber: user.whatsappNumber || "",
        whatsappOptOut: user.whatsappOptOut === true,
        address: user.address?.line1 || "",
        city: user.address?.city || "",
        state: user.address?.state || "",
        country: user.address?.country || "IN",
        zipCode: user.address?.zipcode || "",
        company: user.companyName || "",
        gstNumber: user.gstNumber || "",
      },
    });
  } catch (error) {
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    await connectDB();

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 1 - Authorization
     */
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const body = await request.json();

    // Fields that actually changed in this profile save — passed to the
    // profile-update email so the notification pinpoints WHAT changed instead
    // of a generic "your profile was updated". Populated in the profile block.
    let profileChangedFields: string[] = [];

    // 1. Profile Update Handling
    if (body.profile) {
      /**
       * 🛡️ DEFENSE-IN-DEPTH: Security Layer 2 - Schema Validation
       * Strictly validate the profile object before attempting update.
       * defense: prevent 'Mass Assignment' of fields like 'role'.
       */
      const profileResult = Schemas.profileUpdate.safeParse(body.profile);
      if (!profileResult.success) {
        return secureErrorResponse("Invalid profile data", 400, "VALIDATION_ERROR", profileResult.error.format());
      }

      const p = profileResult.data;

      // Snapshot the current values BEFORE mutation so we can report exactly
      // which fields changed (see the profile-update email below). Compared
      // after the mutations so auto-fills (e.g. phone mirrored from WhatsApp)
      // are captured accurately.
      const snapshot = () => ({
        "First name": user.firstName || "",
        "Last name": user.lastName || "",
        "Company name": user.companyName || "",
        "GST number": user.gstNumber || "",
        "Phone number": user.phone || "",
        "Phone country code": user.phoneCc || "",
        "WhatsApp number": user.whatsappNumber || "",
        "WhatsApp notification preference": user.whatsappOptOut === true ? "off" : "on",
        "Address line 1": user.address?.line1 || "",
        City: user.address?.city || "",
        State: user.address?.state || "",
        Country: user.address?.country || "",
        "Postal code": user.address?.zipcode || "",
      });
      const before = snapshot();

      // WhatsApp number is REQUIRED on a profile save (used for renewal
      // reminders + marketing; also mirrored into `phone` below so it doubles
      // as the domain/KYC contact number). Enforced here as the authoritative
      // gate — the settings page is the sole profile editor + the profile-
      // completion flow, so this covers both. Accepts the value from the
      // request or an already-stored one; rejects an empty result.
      const effectiveWhatsapp = (p.whatsappNumber ?? user.whatsappNumber ?? "").toString().trim();
      if (!effectiveWhatsapp) {
        return secureErrorResponse("WhatsApp number is required", 400, "WHATSAPP_REQUIRED");
      }

      if (p.firstName) user.firstName = p.firstName;
      if (p.lastName) user.lastName = p.lastName;
      if (p.companyName) user.companyName = p.companyName;
      if (p.gstNumber !== undefined) user.gstNumber = p.gstNumber;
      if (p.phone) user.phone = p.phone;
      if (p.phoneCc) user.phoneCc = p.phoneCc;
      if (p.whatsappNumber !== undefined) user.whatsappNumber = p.whatsappNumber || undefined;
      // Customer-facing WhatsApp opt-out toggle — complements the
      // STOP-keyword-driven opt-out set by the inbound webhook. Either
      // path flips the same flag; every WhatsApp send site honors it.
      if (p.whatsappOptOut !== undefined) user.whatsappOptOut = p.whatsappOptOut;

      // Auto-fill phone from WhatsApp when phone is still blank — a
      // WhatsApp-only profile should always have a phone number on file
      // (order updates + domain-registration KYC need one). Server-side
      // safety net mirroring the settings-page UI's auto-fill; covers any
      // save path (API client, older UI, etc.) that supplied a WhatsApp
      // number without a phone. Never overwrites an existing phone.
      if ((!user.phone || user.phone.trim() === "") && user.whatsappNumber) {
        user.phone = user.whatsappNumber;
      }

      if (p.address) {
        if (!user.address) user.address = { line1: '', city: '', state: '', country: '', zipcode: '' };
        if (p.address.line1) user.address.line1 = p.address.line1;
        if (p.address.city) user.address.city = p.address.city;
        if (p.address.state) user.address.state = p.address.state;
        if (p.address.country) user.address.country = p.address.country;
        if (p.address.zipcode) user.address.zipcode = p.address.zipcode;
      }

      user.profileCompleted = checkProfileCompletion(user);

      // Diff the snapshot against the post-mutation values → the exact set of
      // changed field labels for the notification email.
      const after = snapshot();
      profileChangedFields = (Object.keys(before) as Array<keyof typeof before>).filter(
        (label) => before[label] !== after[label]
      );
    }

    // 2. Password Update Handling
    // The User model now has `select: false` on `password`, so the doc
    // loaded by AuthService.getUserFromRequest doesn't carry it. Refetch
    // explicitly when a password update is requested.
    let hadPasswordBefore = false;
    if (body.password) {
      const { currentPassword, newPassword } = body.password;

      /**
       * 🛡️ DEFENSE-IN-DEPTH: Security Layer 3 - Password Strength Enforcement
       */
      const { InputValidator } = await import("@/lib/validation");
      const strength = InputValidator.validatePasswordStrength(newPassword);
      if (!strength.isValid) {
        return secureErrorResponse(strength.errors[0], 400, "WEAK_PASSWORD");
      }

      const userWithPassword = await getUserWithPassword(user._id);
      if (!userWithPassword) {
        return secureErrorResponse("User not found", 404, "USER_NOT_FOUND");
      }
      hadPasswordBefore = !!userWithPassword.password;

      /**
       * 🛡️ DEFENSE-IN-DEPTH: Security Layer 4 - Verify Current Password
       * Prevents account takeover (ATO) if the session is compromised.
       */
      if (userWithPassword.password) {
        if (!currentPassword) {
          return secureErrorResponse("Current password required", 400, "MISSING_PASSWORD");
        }
        if (!(await userWithPassword.comparePassword(currentPassword))) {
          return secureErrorResponse("Incorrect current password", 401, "INVALID_PASSWORD");
        }
        if (await userWithPassword.comparePassword(newPassword)) {
          return secureErrorResponse("New password must be different", 400, "SAME_PASSWORD");
        }
      }

      // Hash is performed automatically by User model pre-save hook.
      // Also mirror the new password onto the working `user` doc so the
      // final `user.save()` below persists it.
      user.password = newPassword;
    }

    await user.save();

    // 3. ResellerClub Sync (Side Effect)
    let resellerClubSynced = false;
    if (body.profile) {
      try {
        let customerId = user.resellerClubCustomerId;

        // Lookup if missing
        if (!customerId) {
          const rcLookup = await ResellerClubAPI.getCustomerId(user.email);
          if (rcLookup.status === "success" && rcLookup.customerId) {
            customerId = rcLookup.customerId;
            user.resellerClubCustomerId = customerId;
            await user.save();
          }
        }

        if (customerId) {
          // Modify existing customer
          const syncResult = await ResellerClubAPI.modifyCustomer({
            username: user.email,
            customerId: customerId,
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
          resellerClubSynced = (syncResult.status === "success");

          // Also push to the contact record — that's what's attached to each
          // domain as the WHOIS contact. modifyCustomer alone doesn't update it.
          if (user.resellerClubContactId) {
            try {
              await ResellerClubAPI.modifyContact({
                contactId: user.resellerClubContactId,
                name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
                company: user.companyName || `${user.firstName || ''} ${user.lastName || ''}`.trim(),
                email: user.email,
                addressLine1: user.address?.line1,
                city: user.address?.city,
                state: user.address?.state,
                country: user.address?.country || 'IN',
                zipcode: user.address?.zipcode,
                phoneCc: (user.phoneCc || '+91').replace(/\+/g, ''),
                phone: user.phone,
              });
            } catch (contactErr) {
              serverLogger.error("[Settings] modifyContact failed:", contactErr);
              // Non-fatal — customer record was updated; contact retry on next save.
            }
          }
        } else {
          // Create new if truly missing
          const { randomBytes } = await import('crypto');
          const customerResult = await ResellerClubAPI.createCustomer({
            username: user.email,
            passwd: randomBytes(8).toString('hex') + 'Aa1!',
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
            resellerClubSynced = true;
          }
        }
      } catch (error) {
        serverLogger.error("RC Sync Error:", error);
      }
    }

    // 3.5 Zoho Books Sync (Side Effect)
    let zohoBooksSynced = false;
    if (body.profile) {
      try {
        const { ZohoBooksService } = await import('@/lib/zohobooks');
        const zohoService = ZohoBooksService.getInstance();
        const contact = await zohoService.getContactByEmail(user.email);
        if (contact) {
            zohoBooksSynced = await zohoService.updateContactDetails(contact.contact_id, user);
        } else {
            await zohoService.createContact(user);
            zohoBooksSynced = true;
        }
      } catch (error) {
        serverLogger.error("Zoho Sync Error:", error);
      }
    }

    // 4. Password Email Notification (Side Effect)
    if (body.password) {
      try {
        const { EmailService } = await import('@/lib/email');
        const isFirstTime = !hadPasswordBefore && user.provider !== 'credentials';
        await EmailService.sendPasswordChangeNotificationEmail(
          user.email,
          `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email,
          isFirstTime,
          user.provider
        );
      } catch (emailError) {
        serverLogger.error("Password Email Notify Error:", emailError);
      }
    }

    // 5. Profile Update Notification (Side Effect)
    // Only notify when something actually changed — a no-op save (form
    // submitted with no edits) shouldn't email the customer. The email lists
    // the exact changed fields so it's useful + a genuine security signal.
    if (body.profile && profileChangedFields.length > 0) {
      try {
        const { EmailService } = await import('@/lib/email');
        await EmailService.sendProfileUpdateEmail(
          user.email,
          `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email,
          profileChangedFields
        );
      } catch (emailError) {
        serverLogger.error("Profile Email Notify Error:", emailError);
      }
    }

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 5 - Secure Response
     */
    return secureJsonResponse({ 
      message: "Settings updated successfully",
      resellerClubSynced,
      zohoBooksSynced,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        profileCompleted: user.profileCompleted,
        role: user.role,
      }
    });
  } catch (error) {
    return secureErrorResponse("Update failed", 500, "SERVER_ERROR", error);
  }
}
