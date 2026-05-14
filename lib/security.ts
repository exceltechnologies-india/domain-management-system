/**
 * Enhanced Security Utilities for Input Validation
 */

export class SecurityValidator {
  // Malicious patterns to detect and block
  private static readonly MALICIOUS_PATTERNS = [
    // SQL Injection patterns
    /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|SCRIPT)\b)/gi,
    /(\b(OR|AND)\s+\d+\s*=\s*\d+)/gi,
    /(\b(OR|AND)\s+['"]\s*=\s*['"])/gi,
    /(UNION\s+SELECT)/gi,
    /(DROP\s+TABLE)/gi,
    /(INSERT\s+INTO)/gi,
    /(DELETE\s+FROM)/gi,
    /(UPDATE\s+SET)/gi,

    // NoSQL Injection patterns
    /\$where/gi,
    /\$ne/gi,
    /\$gt/gi,
    /\$lt/gi,
    /\$regex/gi,
    /\$exists/gi,
    /\$in/gi,
    /\$nin/gi,
    /\$or/gi,
    /\$and/gi,
    /\$not/gi,
    /\$nor/gi,
    /\$all/gi,
    /\$elemMatch/gi,
    /\$size/gi,
    /\$type/gi,

    // XSS patterns
    /<script[^>]*>.*?<\/script>/gi,
    /<iframe[^>]*>.*?<\/iframe>/gi,
    /<object[^>]*>.*?<\/object>/gi,
    /<embed[^>]*>.*?<\/embed>/gi,
    /<link[^>]*>.*?<\/link>/gi,
    /<meta[^>]*>.*?<\/meta>/gi,
    /<style[^>]*>.*?<\/style>/gi,
    /javascript:/gi,
    /vbscript:/gi,
    /onload\s*=/gi,
    /onerror\s*=/gi,
    /onclick\s*=/gi,
    /onmouseover\s*=/gi,
    /onfocus\s*=/gi,
    /onblur\s*=/gi,
    /onchange\s*=/gi,
    /onsubmit\s*=/gi,
    /onreset\s*=/gi,
    /onselect\s*=/gi,
    /onkeydown\s*=/gi,
    /onkeyup\s*=/gi,
    /onkeypress\s*=/gi,

    // Command injection patterns
    /[;&|`$(){}[\]]/g,
    /\b(cat|ls|pwd|whoami|id|uname|ps|netstat|ifconfig|ping|nslookup|dig|wget|curl|nc|telnet|ssh|ftp|sftp|scp|rsync|tar|zip|unzip|gzip|gunzip|bzip2|bunzip2|xz|unxz|7z|rar|unrar)\b/gi,
    /\b(rm|mv|cp|mkdir|rmdir|chmod|chown|chgrp|su|sudo|passwd|useradd|userdel|groupadd|groupdel)\b/gi,
    /\b(service|systemctl|init|kill|killall|pkill|pgrep|top|htop|free|df|du|mount|umount|fdisk|parted|mkfs|fsck)\b/gi,

    // Path traversal patterns
    /\.\.\//g,
    /\.\.\\/g,
    /\.\.%2f/gi,
    /\.\.%5c/gi,
    /\.\.%252f/gi,
    /\.\.%255c/gi,

    // LDAP injection patterns
    /[()=*!&|]/g,
    /\b(uid|cn|sn|givenName|mail|telephoneNumber|memberOf|objectClass)\b/gi,

    // XML injection patterns
    /<[^>]*>/g,
    /<!\[CDATA\[.*?\]\]>/gi,
    /&[a-zA-Z0-9#]+;/g,

    // JSON injection patterns
    /[{}[\]]/g,
    /"[^"]*"\s*:\s*"[^"]*"/g,

    // Buffer overflow patterns
    /.{10000,}/g, // Very long strings
    /[^\x00-\x7F]{1000,}/g, // Very long unicode sequences

    // Null byte injection
    /\x00/g,

    // Control characters
    /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,
  ];

  // Dangerous file extensions
  private static readonly DANGEROUS_EXTENSIONS = [
    ".exe",
    ".bat",
    ".cmd",
    ".com",
    ".pif",
    ".scr",
    ".vbs",
    ".js",
    ".jar",
    ".php",
    ".asp",
    ".aspx",
    ".jsp",
    ".py",
    ".pl",
    ".sh",
    ".cgi",
    ".htaccess",
  ];

  /**
   * Check for malicious patterns in input
   */
  static containsMaliciousPatterns(input: string): {
    isMalicious: boolean;
    patterns: string[];
    sanitized: string;
  } {
    const foundPatterns: string[] = [];
    let sanitized = input;

    for (const pattern of this.MALICIOUS_PATTERNS) {
      if (pattern.test(input)) {
        foundPatterns.push(pattern.toString());
        // Remove the malicious content
        sanitized = sanitized.replace(pattern, "");
      }
    }

    return {
      isMalicious: foundPatterns.length > 0,
      patterns: foundPatterns,
      sanitized: sanitized.trim(),
    };
  }

  /**
   * Validate file upload security
   */
  static validateFileUpload(
    filename: string,
    content: string
  ): {
    isValid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // Check file extension
    const extension = filename
      .toLowerCase()
      .substring(filename.lastIndexOf("."));
    if (this.DANGEROUS_EXTENSIONS.includes(extension)) {
      errors.push(`File type ${extension} is not allowed`);
    }

    // Check for malicious patterns in filename
    const filenameCheck = this.containsMaliciousPatterns(filename);
    if (filenameCheck.isMalicious) {
      errors.push("Filename contains potentially malicious content");
    }

    // Check content size. Bail out before pattern-matching when oversized —
    // the regex set crashes with "Maximum call stack size exceeded" on very
    // large inputs (10 MB+) and the file is already rejected anyway.
    if (content.length > 10 * 1024 * 1024) {
      errors.push("File size exceeds maximum allowed size");
      return { isValid: false, errors };
    }

    // Check for malicious patterns in content
    const contentCheck = this.containsMaliciousPatterns(content);
    if (contentCheck.isMalicious) {
      errors.push("File content contains potentially malicious patterns");
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Enhanced input sanitization
   */
  static sanitizeInput(
    input: string,
    options: {
      maxLength?: number;
      allowHtml?: boolean;
      allowSpecialChars?: boolean;
    } = {}
  ): string {
    const {
      maxLength = 1000,
      allowHtml = false,
      allowSpecialChars = true,
    } = options;

    let sanitized = input;

    // Remove malicious patterns
    const maliciousCheck = this.containsMaliciousPatterns(sanitized);
    sanitized = maliciousCheck.sanitized;

    // Truncate if too long
    if (sanitized.length > maxLength) {
      sanitized = sanitized.substring(0, maxLength);
    }

    // Remove HTML if not allowed
    if (!allowHtml) {
      sanitized = sanitized.replace(/<[^>]*>/g, "");
    }

    // Remove special characters if not allowed
    if (!allowSpecialChars) {
      sanitized = sanitized.replace(/[^a-zA-Z0-9\s\-_.]/g, "");
    }

    // Normalize whitespace
    sanitized = sanitized.replace(/\s+/g, " ").trim();

    return sanitized;
  }

  /**
   * Validate email with enhanced security
   */
  static validateEmailSecurity(email: string): {
    isValid: boolean;
    errors: string[];
    sanitized: string;
  } {
    const errors: string[] = [];

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      errors.push("Invalid email format");
    }

    // Check for malicious patterns
    const maliciousCheck = this.containsMaliciousPatterns(email);
    if (maliciousCheck.isMalicious) {
      errors.push("Email contains potentially malicious content");
    }

    // Check length
    if (email.length > 254) {
      errors.push("Email is too long");
    }

    // Check for suspicious patterns
    if (email.includes("..") || email.includes("@.") || email.includes(".@")) {
      errors.push("Email contains suspicious patterns");
    }

    return {
      isValid: errors.length === 0,
      errors,
      sanitized: maliciousCheck.sanitized.toLowerCase().trim(),
    };
  }

  /**
   * Validate password with enhanced security
   */
  static validatePasswordSecurity(password: string): {
    isValid: boolean;
    errors: string[];
    strength: "weak" | "medium" | "strong";
  } {
    const errors: string[] = [];
    let strength: "weak" | "medium" | "strong" = "weak";

    // Check for malicious patterns
    const maliciousCheck = this.containsMaliciousPatterns(password);
    if (maliciousCheck.isMalicious) {
      errors.push("Password contains potentially malicious content");
    }

    // Length requirements
    if (password.length < 8) {
      errors.push("Password must be at least 8 characters long");
    } else if (password.length >= 12) {
      strength = "strong";
    } else if (password.length >= 8) {
      strength = "medium";
    }

    // Character variety requirements
    const hasLower = /[a-z]/.test(password);
    const hasUpper = /[A-Z]/.test(password);
    const hasNumber = /\d/.test(password);
    const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);

    if (!hasLower) errors.push("Password must contain lowercase letters");
    if (!hasUpper) errors.push("Password must contain uppercase letters");
    if (!hasNumber) errors.push("Password must contain numbers");
    if (!hasSpecial) errors.push("Password must contain special characters");

    // Check for common patterns
    const commonPatterns = [
      /123456/,
      /password/i,
      /admin/i,
      /user/i,
      /qwerty/i,
      /abc123/i,
      /letmein/i,
      /welcome/i,
      /login/i,
    ];

    for (const pattern of commonPatterns) {
      if (pattern.test(password)) {
        errors.push("Password contains common patterns");
        break;
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      strength,
    };
  }

  /**
   * validateCSRF: Implements a dual-layer CSRF (Cross-Site Request Forgery) protection.
   * 
   * This method follows the "Verifying Proper Origins" defense strategy:
   * 1. Check Origin Header: Verifies the 'Origin' header against the authorized app URL.
   * 2. Referer Fallback: If 'Origin' is missing, verifies the 'Referer' header.
   * 3. Production Enforcement: In production, at least one of these headers MUST be present 
   *    and valid for all mutating (POST, PUT, DELETE) requests.
   * 
   * @param request The incoming Next.js request
   * @returns { isValid: boolean, error?: string }
   */
  static validateCSRF(request: Request): {
    isValid: boolean;
    error?: string;
  } {
    // 1. Skip checks for non-mutating (safe) requests
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      return { isValid: true };
    }

    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");
    const authorizedUrl = process.env.NEXTAUTH_URL || process.env.APP_URL;
    if (!authorizedUrl) {
      return { isValid: false, error: "CSRF: NEXTAUTH_URL is not configured" };
    }

    // 2. Strict Origin check (modern browsers always send this for CORS and mutating requests)
    if (origin) {
      if (origin !== authorizedUrl) {
        return { isValid: false, error: "CSRF: Origin mismatch" };
      }
      return { isValid: true };
    }

    // 3. Referer fallback check
    if (referer) {
      if (!referer.startsWith(authorizedUrl)) {
        return { isValid: false, error: "CSRF: Referer mismatch" };
      }
      return { isValid: true };
    }

    // 4. Force failure in production if headers are missing to prevent 'head-less' requests
    if (process.env.NODE_ENV === "production") {
      return { isValid: false, error: "CSRF: Missing security headers" };
    }

    return { isValid: true };
  }
}
