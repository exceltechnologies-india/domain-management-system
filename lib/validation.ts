import validator from "validator";
import { SecurityValidator } from "./security";
import { z } from "zod";

// --- Zod Security Schemas ---

/**
 * Schemas: A collection of reusable Zod validation schemas for the application.
 * 
 * These schemas provide:
 * 1. Type Safety: Ensures incoming data matches expected types.
 * 2. Structure Enforcement: Validates objects and nested fields strictly.
 * 3. Security (Mass Assignment Protection): Using `.strict()` prevents attackers from
 *    injecting unexpected fields into database operations.
 * 4. Data Sanitization: Automatic trimming and normalization (e.g., lowercasing emails).
 */
const passwordSchema = z.string()
  .min(8, "Password must be at least 8 characters long")
  .max(128, "Password is too long")
  .refine((val) => /[A-Z]/.test(val), "Password must contain at least one uppercase letter")
  .refine((val) => /[a-z]/.test(val), "Password must contain at least one lowercase letter")
  .refine((val) => /[0-9]/.test(val), "Password must contain at least one number")
  .refine((val) => /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(val), "Password must contain at least one special character")
  .refine((val) => {
    // Block common weak passwords
    const weakPasswords = ["password", "123456", "admin", "user", "test", "password123", "12345678", "qwerty", "abc123", "letmein", "welcome", "monkey", "1234567890", "password123!", "Password123", "Admin123"];
    return !weakPasswords.includes(val.toLowerCase());
  }, "Password is too weak - please choose a stronger password")
  .refine((val) => !/(.)\1{3,}/.test(val), "Password contains too many repeated characters")
  .refine((val) => {
    // Check for sequential characters (e.g., "1234", "abcd")
    const sequentialPatterns = ["0123456789", "abcdefghijklmnopqrstuvwxyz", "9876543210", "zyxwvutsrqponmlkjihgfedcba"];
    const valLower = val.toLowerCase();
    for (const pattern of sequentialPatterns) {
      for (let i = 0; i <= pattern.length - 4; i++) {
        const seq = pattern.substring(i, i + 4);
        if (valLower.includes(seq)) return false;
      }
    }
    return true;
  }, "Password contains sequential characters which are easy to guess");

export const Schemas = {
  /** MongoDB ObjectId: Validates the 24-character hex string format */
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid ID format"),

  /** Email: Strict format check, trimmed, lowercased, and length-capped for performance & security */
  email: z.string().email("Invalid email format").trim().toLowerCase().max(254),
  
  /** Password: Strict strength check (uppercase, lowercase, number, special char, repetition/sequence check) */
  password: passwordSchema,

  /** Phone: Handles international formats with country code and digits */
  phone: z.object({
    phoneCc: z.string().regex(/^\+[1-9]\d{0,3}$/, "Invalid country code"),
    phone: z.string().regex(/^\d{7,15}$/, "Phone must be 7-15 digits"),
  }).superRefine((data, ctx) => {
    // For India (+91), enforce exactly 10 digits starting with 6-9
    const digitsOnly = data.phone.replace(/[\s\-\(\)\.]/g, "").replace(/^\+/, "");
    if (data.phoneCc === "+91") {
      if (digitsOnly.length !== 10) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Indian mobile numbers must be exactly 10 digits long",
          path: ["phone"],
        });
      } else if (!/^[6-9]/.test(digitsOnly)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Indian mobile numbers must start with 6, 7, 8, or 9",
          path: ["phone"],
        });
      }
    }
  }),

  /** Address: Validates common shipping/billing address fields with length constraints */
  address: z.object({
    line1: z.string().min(2).max(200).trim(),
    city: z.string().min(2).max(100).trim(),
    state: z.string().min(2).max(100).trim(),
    country: z.string().length(2, "Must be a 2-letter country code").toUpperCase(),
    zipcode: z.string().regex(/^[A-Z0-9\s\-]{3,10}$/i, "Invalid ZIP code format"),
  }),

  /** Profile Update: Whitelists specific fields for user settings updates. 
   * Strict mode prevents malicious mass assignment of system-only fields like 'role'.
   */
  profileUpdate: z.object({
    firstName: z.string().max(50).optional(),
    lastName: z.string().max(50).optional(),
    companyName: z.string().max(100).optional(),
    gstNumber: z.string().max(15).optional().or(z.literal("")),
    phone: z.string().max(20).optional(),
    phoneCc: z.string().max(20).optional(),
    whatsappNumber: z.string().max(15).optional().or(z.literal("")),
    whatsappOptOut: z.boolean().optional(),
    address: z.object({
      line1: z.string().max(200).optional(),
      city: z.string().max(100).optional(),
      state: z.string().max(100).optional(),
      country: z.string().max(100).optional(),
      zipcode: z.string().max(15).optional(),
    }).optional(),
  }),

  /** Admin User Update: Only allows modifying the role of a specific user. */
  adminUserUpdate: z.object({
    userId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid User ID"),
    role: z.enum(["user", "admin"]),
  }).strict(),

  registration: z.object({
    email: z.string().email("Invalid email format").trim().toLowerCase().max(254),
    password: passwordSchema,
    firstName: z.string().min(1).max(50).trim(),
    lastName: z.string().min(1).max(50).trim(),
    // WhatsApp number is REQUIRED at signup (renewal reminders + marketing;
    // mirrored into `phone` server-side so it also serves domain/KYC contact).
    whatsappNumber: z.string().trim().regex(/^\d{10}$/, "Enter a 10-digit WhatsApp number"),
    // phone/address/company are collected post-registration via the Complete Profile flow
    phone: z.string().max(20).optional(),
    phoneCc: z.string().max(20).optional(),
    companyName: z.string().max(100).optional(),
    gstNumber: z.string().max(15).optional().or(z.literal("")),
    address: z.object({
      line1: z.string().max(200).trim().optional().default(""),
      city: z.string().max(100).trim().optional().default(""),
      state: z.string().max(100).trim().optional().default(""),
      country: z.string().max(100).optional().default("IN"),
      zipcode: z.string().max(15).optional().default(""),
    }).optional(),
    // reCAPTCHA token: optional at the schema layer because dev / non-
    // production environments may run without RECAPTCHA_SECRET_KEY set;
    // the route's RecaptchaServer.verifyToken short-circuits to success
    // when the secret is empty/placeholder so the optional shape is safe.
    recaptchaToken: z.string().optional().nullable(),
  }),

  /** Forgot Password: Validates the request to initiate a password recovery. */
  forgotPassword: z.object({
    email: z.string().email("Invalid email format").trim().toLowerCase(),
    recaptchaToken: z.string().optional().nullable(),
  }).strict(),

  /** Reset Password: Validates the final stage of password recovery with strict complexity checks. */
  resetPassword: z.object({
    token: z.string().min(1, "Reset token is required"),
    password: passwordSchema,
    recaptchaToken: z.string().optional().nullable(),
  }).strict(),

  /** DNS Record: Validates DNS entries for domain configuration. */
  dnsRecord: z.object({
    type: z.enum(["A", "AAAA", "MX", "CNAME", "TXT", "NS", "SRV"]),
    name: z.string().max(255).trim(),
    value: z.string().min(1).trim(),
    ttl: z.number().int().min(60).max(86400),
    priority: z.number().int().min(0).max(65535).optional(),
  }),

  /** Domain Name: Regex-based validation for FQDN (Fully Qualified Domain Name). */
  domainName: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i, "Invalid domain name"),
};

/** Result interface for the legacy InputValidator methods */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  // `sanitized` is the cleaned/normalized form of whatever was validated;
  // for primitive validators (email, domain) it's a string, for compound
  // validators (address) it's a Record<string,string> of cleaned fields.
  sanitized?: string | Record<string, string>;
}

/**
 * InputValidator: A utility class for validating and sanitizing common user inputs.
 * 
 * This class provides methods for:
 * 1. Basic input validation (e.g., email, password, names).
 * 2. Sanitization (e.g., trimming whitespace, lowercasing emails).
 * 3. Security checks (e.g., buffer overflow protection, weak password detection).
 * 4. Compatibility with legacy validation patterns.
 */
export class InputValidator {
  /**
   * Validate and sanitize email
   */
  static validateEmail(email: string): ValidationResult {
    const errors: string[] = [];

    if (!email || typeof email !== "string") {
      errors.push("Email is required");
      return { isValid: false, errors };
    }

    // Buffer overflow protection - limit input size
    if (email.length > 1000) {
      errors.push("Email input is too large");
      return { isValid: false, errors };
    }

    // Trim and normalize
    const sanitizedEmail = email.trim().toLowerCase();

    if (!validator.isEmail(sanitizedEmail)) {
      errors.push("Invalid email format");
    }

    if (sanitizedEmail.length > 254) {
      errors.push("Email is too long");
    }

    return {
      isValid: errors.length === 0,
      errors,
      sanitized: sanitizedEmail,
    };
  }

  /**
   * Validate and sanitize password
   */
  static validatePassword(password: string): ValidationResult {
    const errors: string[] = [];

    if (!password || typeof password !== "string") {
      errors.push("Password is required");
      return { isValid: false, errors };
    }

    // Buffer overflow protection - limit input size
    if (password.length > 1000) {
      errors.push("Password input is too large");
      return { isValid: false, errors };
    }

    if (password.length < 8) {
      errors.push("Password must be at least 8 characters long");
    }

    if (password.length > 128) {
      errors.push("Password is too long");
    }

    // Check for common weak passwords
    const weakPasswords = ["password", "123456", "admin", "user", "test", "password123", "12345678", "qwerty", "abc123", "letmein", "welcome", "monkey", "1234567890"];
    if (weakPasswords.includes(password.toLowerCase())) {
      errors.push("Password is too weak - please choose a stronger password");
    }

    return {
      isValid: errors.length === 0,
      errors,
      sanitized: password,
    };
  }

  /**
   * Validate password strength with enhanced requirements
   */
  static validatePasswordStrength(password: string): ValidationResult {
    const errors: string[] = [];
    const strengthChecks = {
      length: password.length >= 8,
      hasUpperCase: /[A-Z]/.test(password),
      hasLowerCase: /[a-z]/.test(password),
      hasNumber: /[0-9]/.test(password),
      hasSpecialChar: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password),
    };

    if (!strengthChecks.length) {
      errors.push("Password must be at least 8 characters long");
    }

    if (!strengthChecks.hasUpperCase) {
      errors.push("Password must contain at least one uppercase letter");
    }

    if (!strengthChecks.hasLowerCase) {
      errors.push("Password must contain at least one lowercase letter");
    }

    if (!strengthChecks.hasNumber) {
      errors.push("Password must contain at least one number");
    }

    if (!strengthChecks.hasSpecialChar) {
      errors.push("Password must contain at least one special character (!@#$%^&*()_+-=[]{}|;':\",./<>?)");
    }

    // Check for common weak passwords
    const weakPasswords = ["password", "123456", "admin", "user", "test", "password123", "12345678", "qwerty", "abc123", "letmein", "welcome", "monkey", "1234567890", "password123!", "Password123", "Admin123"];
    if (weakPasswords.includes(password.toLowerCase()) || weakPasswords.includes(password)) {
      errors.push("Password is too weak - please choose a stronger password");
    }

    // Check for repeated characters (e.g., "aaaaaa", "111111")
    if (/(.)\1{3,}/.test(password)) {
      errors.push("Password contains too many repeated characters");
    }

    // Check for sequential characters (e.g., "123456", "abcdef")
    const sequentialPatterns = ["0123456789", "abcdefghijklmnopqrstuvwxyz", "9876543210", "zyxwvutsrqponmlkjihgfedcba"];
    const passwordLower = password.toLowerCase();
    for (const pattern of sequentialPatterns) {
      for (let i = 0; i <= pattern.length - 4; i++) {
        const seq = pattern.substring(i, i + 4);
        if (passwordLower.includes(seq)) {
          errors.push("Password contains sequential characters which are easy to guess");
          break;
        }
      }
      if (errors.length > 0) break;
    }

    return {
      isValid: errors.length === 0,
      errors,
      sanitized: password,
    };
  }

  /**
   * Check if new password is different from current password
   */
  static async checkPasswordDifference(
    currentPassword: string,
    newPassword: string,
    comparePasswordFn: (candidatePassword: string) => Promise<boolean>
  ): Promise<{ isDifferent: boolean; error?: string }> {
    if (currentPassword === newPassword) {
      return {
        isDifferent: false,
        error: "New password must be different from your current password",
      };
    }

    // Compare the new password with the hashed current password
    const isSame = await comparePasswordFn(newPassword);
    if (isSame) {
      return {
        isDifferent: false,
        error: "New password must be different from your current password",
      };
    }

    return { isDifferent: true };
  }

  /**
   * Validate and sanitize name fields
   */
  static validateName(
    name: string,
    fieldName: string = "Name"
  ): ValidationResult {
    const errors: string[] = [];

    if (!name || typeof name !== "string") {
      errors.push(`${fieldName} is required`);
      return { isValid: false, errors };
    }

    // Buffer overflow protection - limit input size
    if (name.length > 1000) {
      errors.push(`${fieldName} input is too large`);
      return { isValid: false, errors };
    }

    // Trim whitespace
    const sanitized = name.trim();

    if (sanitized.length < 2) {
      errors.push(`${fieldName} must be at least 2 characters long`);
    }

    if (sanitized.length > 50) {
      errors.push(`${fieldName} is too long`);
    }

    // Check for valid characters (letters, spaces, hyphens, apostrophes)
    if (!/^[a-zA-Z\s\-']+$/.test(sanitized)) {
      errors.push(`${fieldName} contains invalid characters`);
    }

    // Enhanced security validation
    const securityCheck =
      SecurityValidator.containsMaliciousPatterns(sanitized);
    if (securityCheck.isMalicious) {
      errors.push(`${fieldName} contains potentially malicious content`);
    }

    // Use sanitized version from security check
    const finalSanitized = securityCheck.sanitized;

    return {
      isValid: errors.length === 0,
      errors,
      sanitized: finalSanitized,
    };
  }

  /**
   * Validate and sanitize phone number
   */
  static validatePhone(phone: string, phoneCc?: string): ValidationResult {
    const errors: string[] = [];

    if (!phone || typeof phone !== "string") {
      errors.push("Phone number is required");
      return { isValid: false, errors };
    }

    // Buffer overflow protection - limit input size
    if (phone.length > 50) {
      errors.push("Phone number is too long");
      return { isValid: false, errors };
    }

    // Trim whitespace
    const sanitized = phone.trim();

    // Remove common phone number formatting
    const cleaned = sanitized.replace(/[\s\-\(\)\.]/g, "");

    // Check if it's a valid phone number (digits only, with optional + at start)
    if (!/^\+?[0-9]+$/.test(cleaned)) {
      errors.push(
        "Phone number must contain only digits and optional + prefix"
      );
    }

    // Check length (minimum 7 digits, maximum 15 digits)
    const digitsOnly = cleaned.replace(/^\+/, "");
    
    // For India (+91), enforce exactly 10 digits starting with 6-9
    const isIndia = phoneCc === "+91";
    if (isIndia) {
      if (digitsOnly.length !== 10) {
        errors.push("Indian mobile numbers must be exactly 10 digits long");
      } else if (!/^[6-9]/.test(digitsOnly)) {
        errors.push("Indian mobile numbers must start with 6, 7, 8, or 9");
      }
    } else {
      // General International validation
      if (digitsOnly.length < 7) {
        errors.push("Phone number must be at least 7 digits long");
      }
    }

    if (digitsOnly.length > 15) {
      errors.push("Phone number is too long");
    }

    // Enhanced security validation
    const securityCheck =
      SecurityValidator.containsMaliciousPatterns(sanitized);
    if (securityCheck.isMalicious) {
      errors.push("Phone number contains potentially malicious content");
    }

    return {
      isValid: errors.length === 0,
      errors,
      sanitized: securityCheck.sanitized,
    };
  }

  /**
   * Validate and sanitize phone country code
   */
  static validatePhoneCc(phoneCc: string): ValidationResult {
    const errors: string[] = [];

    if (!phoneCc || typeof phoneCc !== "string") {
      errors.push("Phone country code is required");
      return { isValid: false, errors };
    }

    // Buffer overflow protection - limit input size
    if (phoneCc.length > 10) {
      errors.push("Phone country code is too long");
      return { isValid: false, errors };
    }

    // Trim whitespace
    const sanitized = phoneCc.trim();

    // Validate country code format (+XX or +XXX)
    if (!/^\+[1-9]\d{0,3}$/.test(sanitized)) {
      errors.push("Phone country code must be in format +XX or +XXX (e.g., +91, +1, +44)");
    }

    // Enhanced security validation
    const securityCheck = SecurityValidator.containsMaliciousPatterns(sanitized);
    if (securityCheck.isMalicious) {
      errors.push("Phone country code contains potentially malicious content");
    }

    return {
      isValid: errors.length === 0,
      errors,
      sanitized: securityCheck.sanitized,
    };
  }

  /**
   * Validate and sanitize address
   */
  static validateAddress(address: {
    line1: string;
    city: string;
    state: string;
    country: string;
    zipcode: string;
  }): ValidationResult {
    const errors: string[] = [];

    if (!address || typeof address !== "object") {
      errors.push("Address is required");
      return { isValid: false, errors };
    }

    // Validate each address field
    const requiredFields = [
      { key: "line1", name: "Address Line 1" },
      { key: "city", name: "City" },
      { key: "state", name: "State" },
      { key: "country", name: "Country" },
      { key: "zipcode", name: "ZIP Code" },
    ];

    const sanitized: Record<string, string> = {};

    for (const field of requiredFields) {
      const value = address[field.key as keyof typeof address];

      if (!value || typeof value !== "string") {
        errors.push(`${field.name} is required`);
        continue;
      }

      // Buffer overflow protection
      if (value.length > 200) {
        errors.push(`${field.name} is too long`);
        continue;
      }

      // Trim whitespace
      const trimmed = value.trim();

      if (trimmed.length < 2) {
        errors.push(`${field.name} must be at least 2 characters long`);
        continue;
      }

      // Enhanced security validation
      const securityCheck =
        SecurityValidator.containsMaliciousPatterns(trimmed);
      if (securityCheck.isMalicious) {
        errors.push(`${field.name} contains potentially malicious content`);
        continue;
      }

      sanitized[field.key] = securityCheck.sanitized;
    }

    // Additional validation for specific fields
    if (sanitized.country && !/^[A-Z]{2}$/.test(sanitized.country)) {
      errors.push("Country must be a 2-letter country code (e.g., IN, US)");
    }

    if (sanitized.zipcode && !/^[A-Z0-9\s\-]{3,10}$/i.test(sanitized.zipcode)) {
      errors.push("ZIP code format is invalid");
    }

    return {
      isValid: errors.length === 0,
      errors,
      sanitized,
    };
  }

  /**
   * Validate and sanitize domain name
   */
  static validateDomainName(domainName: string): ValidationResult {
    const errors: string[] = [];

    if (!domainName || typeof domainName !== "string") {
      errors.push("Domain name is required");
      return { isValid: false, errors };
    }

    const sanitized = domainName.replace(/\s+/g, "").toLowerCase();

    if (sanitized.length < 3) {
      errors.push("Domain name is too short");
    }

    if (sanitized.length > 253) {
      errors.push("Domain name is too long");
    }

    // Basic domain validation
    const domainRegex =
      /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/;
    if (!domainRegex.test(sanitized)) {
      errors.push("Invalid domain name format");
    }

    return {
      isValid: errors.length === 0,
      errors,
      sanitized,
    };
  }

  /**
   * Validate and sanitize contact form message
   */
  static validateMessage(
    message: string,
    fieldName: string = "Message"
  ): ValidationResult {
    const errors: string[] = [];

    if (!message || typeof message !== "string") {
      errors.push(`${fieldName} is required`);
      return { isValid: false, errors };
    }

    // Buffer overflow protection - limit input size
    if (message.length > 10000) {
      errors.push(`${fieldName} input is too large`);
      return { isValid: false, errors };
    }

    const sanitized = message.trim();

    if (sanitized.length < 10) {
      errors.push(`${fieldName} must be at least 10 characters long`);
    }

    if (sanitized.length > 2000) {
      errors.push(`${fieldName} is too long`);
    }

    // Enhanced security validation
    const securityCheck =
      SecurityValidator.containsMaliciousPatterns(sanitized);
    if (securityCheck.isMalicious) {
      errors.push(`${fieldName} contains potentially malicious content`);
    }

    // Use sanitized version from security check
    const finalSanitized = securityCheck.sanitized;

    return {
      isValid: errors.length === 0,
      errors,
      sanitized: finalSanitized,
    };
  }

  /**
   * Validate MongoDB ObjectId
   */
  static validateObjectId(id: string): ValidationResult {
    const errors: string[] = [];

    if (!id || typeof id !== "string") {
      errors.push("ID is required");
      return { isValid: false, errors };
    }

    if (!validator.isMongoId(id)) {
      errors.push("Invalid ID format");
    }

    return {
      isValid: errors.length === 0,
      errors,
      sanitized: id,
    };
  }

  /**
   * Sanitize HTML content
   */
  static sanitizeHtml(html: string): string {
    return html
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;")
      .replace(/\//g, "&#x2F;");
  }

  /**
   * Validate array of domain IDs
   */
  static validateDomainIds(domainIds: unknown): ValidationResult {
    const errors: string[] = [];

    if (!Array.isArray(domainIds)) {
      errors.push("Domain IDs must be an array");
      return { isValid: false, errors };
    }

    if (domainIds.length === 0) {
      errors.push("At least one domain ID is required");
      return { isValid: false, errors };
    }

    if (domainIds.length > 10) {
      errors.push("Too many domains selected");
      return { isValid: false, errors };
    }

    for (const id of domainIds) {
      const idValidation = this.validateObjectId(id);
      if (!idValidation.isValid) {
        errors.push(`Invalid domain ID: ${id}`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      sanitized: domainIds.join(","),
    };
  }
}
