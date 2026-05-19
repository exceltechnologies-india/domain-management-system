/**
 * NextAuth callbacks: signIn, jwt, session.
 */

import { Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import connectDB from "@/lib/mongodb";
import User from "@/models/User";
import { serverLogger } from "@/lib/server-logger";
import { updateLastActivity, checkSessionTimeout } from "@/lib/session-activity";
import { PASSWORD_ROTATION_DAYS } from "@/config/constants";
import { SOCIAL_PROVIDERS, extractSocialName } from "./helpers";

export const callbacks = {
  // NextAuth callback parameters carry provider-specific shapes that vary
  // by provider (Google vs. credentials vs. GitHub). The callbacks read
  // fields defensively across those shapes — keep `any` here rather than
  // forcing a narrowing that would lie about the runtime shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async signIn({ user, account, profile }: any) {
    serverLogger.log("========================================");
    serverLogger.log("[SIGNIN CALLBACK] 🔐 SignIn attempt started");
    serverLogger.log("[SIGNIN CALLBACK] User email:", user.email);
    serverLogger.log(
      "[SIGNIN CALLBACK] Provider:",
      account?.provider || "unknown"
    );
    serverLogger.log("========================================");

    // Prevent admin users from using social login
    if (account?.provider && SOCIAL_PROVIDERS.includes(account.provider)) {
      // GitHub may return null email for users with private email settings
      if (!user.email) {
        serverLogger.warn(
          "[SIGNIN] ❌ BLOCKED - No email returned from provider:",
          account.provider
        );
        return false;
      }

      try {
        await connectDB();

        // Check if this email belongs to an existing user
        const existingUser = await User.findOne({
          email: user.email,
        });

        if (existingUser) {
          // Block admin users from social login
          if (existingUser.role === "admin") {
            serverLogger.warn(
              "[SIGNIN] ❌ BLOCKED - Admin users cannot use social login:",
              user.email
            );
            return false;
          }

          // Block disabled users from social login
          if (!existingUser.isActive) {
            serverLogger.warn(
              "[SIGNIN] ❌ BLOCKED - User account is disabled:",
              user.email
            );
            return false;
          }
        }

        serverLogger.log(
          "[SIGNIN CALLBACK] ✅ Social login approved for:",
          user.email,
          "via",
          account.provider
        );
      } catch (error) {
        serverLogger.error(
          "[SIGNIN CALLBACK] ❌ Error checking user:",
          error
        );
        return false; // Block on error for security
      }
    }

    serverLogger.log("[SIGNIN CALLBACK] ✅ Returning TRUE - login approved");
    return true;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async jwt({ token, user, account, profile }: any) {
    serverLogger.log(
      "[JWT CALLBACK] Called with user:",
      user ? user.email : "no user"
    );
    serverLogger.log(
      "[JWT CALLBACK] Account provider:",
      account ? account.provider : "no account"
    );

    // On token refresh (no user/account), check if user is still active and session not invalidated
    if (!user && !account && token?.id) {
      try {
        await connectDB();
        const dbUser = await User.findById(token.id).select("isActive role sessionInvalidatedAt passwordChangedAt profileCompleted");

        if (!dbUser || !dbUser.isActive) {
          serverLogger.warn(
            "[JWT CALLBACK] ❌ User account is disabled or not found on token refresh:",
            token.id
          );
          // Return null to invalidate token (NextAuth v4 runtime handles null by clearing session)
          return null as unknown as JWT;
        }

        // Check if session was invalidated after token was created
        const tokenIssuedAtMs = token.iat && typeof token.iat === 'number' ? token.iat * 1000 : Date.now(); // Convert to milliseconds
        if (dbUser.sessionInvalidatedAt && new Date(dbUser.sessionInvalidatedAt).getTime() > tokenIssuedAtMs) {
          serverLogger.warn(
            "[JWT CALLBACK] ❌ Session invalidated - user was disabled:",
            token.id,
            "Invalidated at:",
            dbUser.sessionInvalidatedAt
          );
          return null as unknown as JWT;
        }

        // Check session timeout
        const tokenIssuedAt = token.iat && typeof token.iat === 'number' ? token.iat : undefined;
        const timeoutCheck = await checkSessionTimeout(token.id as string, tokenIssuedAt);
        if (timeoutCheck.isExpired) {
          serverLogger.warn(
            "[JWT CALLBACK] ❌ Session expired due to inactivity:",
            token.id,
            "Timeout:",
            timeoutCheck.timeoutMinutes,
            "minutes"
          );
          return null as unknown as JWT;
        }

        // Update last activity
        await updateLastActivity(token.id as string);

        // Flag admin accounts with stale passwords
        if (dbUser.role === "admin") {
          const rotationMs = PASSWORD_ROTATION_DAYS * 24 * 60 * 60 * 1000;
          const lastChange = dbUser.passwordChangedAt?.getTime() ?? 0;
          token.passwordExpired = Date.now() - lastChange > rotationMs;
        }

        // Update token with latest user data
        token.role = dbUser.role;
        token.profileCompleted = dbUser.profileCompleted === true;
      } catch (error) {
        serverLogger.error(
          "[JWT CALLBACK] ❌ Error checking user status on refresh:",
          error
        );
        // On error, still return token but log it
      }
    }

    if (user && account) {
      await connectDB();

      // Handle social login user creation/update
      if (SOCIAL_PROVIDERS.includes(account.provider)) {
        serverLogger.log(
          "[JWT CALLBACK] Processing social login for:",
          user.email,
          "via",
          account.provider
        );
        let dbUser = await User.findOne({ email: user.email });

        // Fetch additional user data from Google/Facebook if access token available
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let additionalData: any = {};

        // DISABLED: These scopes require Google verification for production apps
        // Re-enable after getting verification for sensitive scopes
        /*
        if (account.provider === "google" && account.access_token) {
          try {
            // Fetch phone numbers and addresses from Google People API
            const peopleResponse = await fetch(
              "https://people.googleapis.com/v1/people/me?personFields=phoneNumbers,addresses",
              {
                headers: {
                  Authorization: `Bearer ${account.access_token}`,
                },
              }
            );

            if (peopleResponse.ok) {
              const peopleData = await peopleResponse.json();

              // Extract phone number
              if (
                peopleData.phoneNumbers &&
                peopleData.phoneNumbers.length > 0
              ) {
                const primaryPhone = peopleData.phoneNumbers[0].value;
                // Parse phone number (assuming Indian format)
                const cleanPhone = primaryPhone.replace(/\D/g, "");
                if (cleanPhone.length === 10) {
                  additionalData.phone = cleanPhone;
                  additionalData.phoneCc = "+91";
                } else if (cleanPhone.length > 10) {
                  additionalData.phone = cleanPhone.slice(-10);
                  additionalData.phoneCc = "+" + cleanPhone.slice(0, -10);
                }
              }

              // Extract address
              if (peopleData.addresses && peopleData.addresses.length > 0) {
                const primaryAddress = peopleData.addresses[0];
                additionalData.address = {
                  line1: primaryAddress.streetAddress || "",
                  city: primaryAddress.city || "",
                  state: primaryAddress.region || "",
                  country: primaryAddress.countryCode || "IN",
                  zipcode: primaryAddress.postalCode || "",
                };
              }
            }
          } catch (error) {
            // Silent fail - additional data is optional
          }
        }
        */

        // DISABLED: Facebook additional scopes also disabled for consistency
        /*
        if (account.provider === "facebook" && account.access_token) {
          try {
            // Fetch user data from Facebook Graph API
            const fbResponse = await fetch(
              `https://graph.facebook.com/me?fields=mobile_phone,location{location{city,state,country,zip}}&access_token=${account.access_token}`
            );

            if (fbResponse.ok) {
              const fbData = await fbResponse.json();

              // Extract phone number
              if (fbData.mobile_phone) {
                const cleanPhone = fbData.mobile_phone.replace(/\D/g, "");
                if (cleanPhone.length === 10) {
                  additionalData.phone = cleanPhone;
                  additionalData.phoneCc = "+91";
                } else if (cleanPhone.length > 10) {
                  additionalData.phone = cleanPhone.slice(-10);
                  additionalData.phoneCc = "+" + cleanPhone.slice(0, -10);
                }
              }

              // Extract address from location
              if (fbData.location && fbData.location.location) {
                const loc = fbData.location.location;
                additionalData.address = {
                  line1: "",
                  city: loc.city || "",
                  state: loc.state || "",
                  country: loc.country || "IN",
                  zipcode: loc.zip || "",
                };
              }
            }
          } catch (error) {
            // Silent fail - additional data is optional
          }
        }
        */

        if (!dbUser) {
          // Create new user from social login with enhanced profile data
          serverLogger.log(
            "[JWT CALLBACK] Creating new user from social login via",
            account.provider
          );
          const { firstName, lastName } = extractSocialName(account.provider, profile, user);

          // Check if we have enough data to mark profile as complete
          const hasPhone = additionalData.phone && additionalData.phoneCc;
          const hasAddress =
            additionalData.address &&
            additionalData.address.line1 &&
            additionalData.address.city;
          const isProfileComplete = hasPhone && hasAddress;

          dbUser = new User({
            email: user.email,
            firstName,
            lastName,
            // Auto-populate phone if available from Google
            phone: additionalData.phone || undefined,
            phoneCc: additionalData.phoneCc || undefined,
            // Auto-populate address if available from Google
            address: additionalData.address || undefined,
            provider: account.provider,
            providerId: account.providerAccountId,
            role: "user",
            isActive: true,
            isActivated: true,
            // Mark as complete if we have all required fields
            profileCompleted: isProfileComplete,
          });

          try {
            await dbUser.save();
          } catch (error) {
            serverLogger.error("[JWT CALLBACK] Error creating user:", error);
            throw error;
          }

          // Update last activity on new social login user
          await updateLastActivity(String(dbUser._id ?? ""));

          // Only send profile completion email if profile is incomplete
          if (!isProfileComplete) {
            const { EmailService } = await import("@/lib/email");
            EmailService.sendProfileCompletionEmail(
              user.email || "",
              `${firstName} ${lastName}`.trim()
            ).catch((error) => {
              serverLogger.error("Profile completion email failed");
            });
          }
        } else {
          // Check if user is disabled before allowing login
          if (!dbUser.isActive) {
            serverLogger.warn(
              "[JWT CALLBACK] ❌ User account is disabled:",
              user.email
            );
            return null as unknown as JWT;
          }

          // Check if session was invalidated (user was disabled)
          if (dbUser.sessionInvalidatedAt) {
            serverLogger.warn(
              "[JWT CALLBACK] ❌ Session invalidated - user was disabled:",
              user.email,
              "Invalidated at:",
              dbUser.sessionInvalidatedAt
            );
            return null as unknown as JWT;
          }

          // Existing user found - update with social data and auto-populate missing fields
          let needsUpdate = false;

          // Auto-populate missing phone number from Google
          if (
            additionalData.phone &&
            additionalData.phoneCc &&
            !dbUser.phone
          ) {
            dbUser.phone = additionalData.phone;
            dbUser.phoneCc = additionalData.phoneCc;
            needsUpdate = true;
          }

          // Auto-populate missing address from Google
          if (additionalData.address && additionalData.address.line1) {
            if (!dbUser.address || !dbUser.address.line1) {
              dbUser.address = additionalData.address;
              needsUpdate = true;
            }
          }

          // Update name if better data available
          const extracted = extractSocialName(account.provider, profile, user);
          if (extracted.firstName && !dbUser.firstName) {
            dbUser.firstName = extracted.firstName;
            needsUpdate = true;
          }
          if (extracted.lastName && !dbUser.lastName) {
            dbUser.lastName = extracted.lastName;
            needsUpdate = true;
          }

          // Check if user now has a complete profile after auto-population
          const hasCompleteProfile = dbUser.profileCompleted === true;
          const hasAddress =
            dbUser.address && dbUser.address.line1 && dbUser.address.city;
          const hasPhone = dbUser.phone && dbUser.phoneCc;

          // If user has all required fields, they have a complete profile
          const isProfileActuallyComplete =
            hasCompleteProfile || (hasAddress && hasPhone);

          // Only update provider if they don't have one
          // Do NOT overwrite "credentials" provider to preserve password login
          if (!dbUser.provider) {
            dbUser.provider = account.provider;
            dbUser.providerId = account.providerAccountId;
            needsUpdate = true;
          }

          // Always ensure social login users are activated
          if (!dbUser.isActivated) {
            dbUser.isActivated = true;
            needsUpdate = true;
          }

          // Update profileCompleted status based on actual data
          if (isProfileActuallyComplete && !dbUser.profileCompleted) {
            dbUser.profileCompleted = true;
            needsUpdate = true;
          }

          // Save only if there are updates
          if (needsUpdate) {
            await dbUser.save();
          }

          // Update last activity on social login
          await updateLastActivity(String(dbUser._id ?? ""));
        }

        token.role = dbUser.role;
        token.id = dbUser._id?.toString() || "";
        token.profileCompleted = dbUser.profileCompleted;
        token.provider = account.provider;
        serverLogger.log(
          "[JWT CALLBACK] Social login - Set token for:",
          user.email
        );
      } else if (user) {
        // Regular credential login
        serverLogger.log(
          "[JWT CALLBACK] Credentials login - Setting token for:",
          user.email
        );
        token.role = user.role;
        token.id = user.id;
        token.provider = "credentials";

        // Load profileCompleted from DB so first-time guest-converted logins
        // don't see the "complete your profile" banner. The credentials
        // authorize callback returns a minimal user — fetch the rest here.
        try {
          const dbUser = await User.findById(user.id).select("profileCompleted");
          if (dbUser) {
            token.profileCompleted = dbUser.profileCompleted === true;
          }
        } catch (err) {
          serverLogger.error(
            "[JWT CALLBACK] Failed to load profileCompleted on credentials login:",
            err
          );
        }

        serverLogger.log(
          "[JWT CALLBACK] Token set - role:",
          token.role,
          "id:",
          token.id,
          "profileCompleted:",
          token.profileCompleted
        );
      }
    }

    return token;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async session({ session, token }: any) {
    serverLogger.log("========================================");
    serverLogger.log("[SESSION CALLBACK] 📋 Creating session");
    serverLogger.log("[SESSION CALLBACK] Token present:", !!token);
    serverLogger.log("[SESSION CALLBACK] Token role:", token?.role || "none");
    serverLogger.log(
      "[SESSION CALLBACK] User email:",
      session?.user?.email || "none"
    );

    if (token && session.user) {
      // Check if user is still active and session not invalidated before creating session
      if (token.id) {
        try {
          await connectDB();
          const dbUser = await User.findById(token.id).select("isActive sessionInvalidatedAt");

          if (!dbUser || !dbUser.isActive) {
            serverLogger.warn(
              "[SESSION CALLBACK] ❌ User account is disabled or not found:",
              session.user.email
            );
            // Return null to invalidate session (NextAuth v4 runtime handles null by clearing session)
            return null as unknown as Session;
          }

          // Check if session was invalidated (user was disabled)
          // Compare token issued time with session invalidation time
          const tokenIssuedAt = token.iat && typeof token.iat === 'number' ? token.iat * 1000 : Date.now(); // Convert to milliseconds
          if (dbUser.sessionInvalidatedAt && new Date(dbUser.sessionInvalidatedAt).getTime() > tokenIssuedAt) {
            serverLogger.warn(
              "[SESSION CALLBACK] ❌ Session invalidated - user was disabled:",
              session.user.email,
              "Invalidated at:",
              dbUser.sessionInvalidatedAt
            );
            return null as unknown as Session;
          }

          // Check session timeout
          const sessionTokenIssuedAt = token.iat && typeof token.iat === 'number' ? token.iat : undefined;
          const timeoutCheck = await checkSessionTimeout(token.id as string, sessionTokenIssuedAt);
          if (timeoutCheck.isExpired) {
            serverLogger.warn(
              "[SESSION CALLBACK] ❌ Session expired due to inactivity:",
              session.user.email,
              "Timeout:",
              timeoutCheck.timeoutMinutes,
              "minutes"
            );
            return null as unknown as Session;
          }

          // Update last activity
          await updateLastActivity(token.id as string);
        } catch (error) {
          serverLogger.error(
            "[SESSION CALLBACK] ❌ Error checking user status:",
            error
          );
          // On error, still allow session but log it
        }
      }

      session.user.id = token.id ?? "";
      session.user.role = (token.role as "admin" | "user") ?? "user";
      session.user.profileCompleted = token.profileCompleted;
      session.user.provider = token.provider;
      if (token.passwordExpired !== undefined) {
        session.user.passwordExpired = token.passwordExpired;
      }

      serverLogger.log(
        "[SESSION CALLBACK] ✅ Session created for:",
        session.user.email,
        "with role:",
        token.role
      );
    }
    serverLogger.log("========================================");
    return session;
  },
};
