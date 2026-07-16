import { describe, it, expect } from "vitest";
import { Schemas, InputValidator } from "@/lib/validation";

// ─── Zod Schemas ────────────────────────────────────────────────────────────

describe("Schemas.email", () => {
  it("accepts a valid email and lowercases it", () => {
    // Zod v4 runs .email() before .trim(), so pass without surrounding whitespace
    const result = Schemas.email.safeParse("USER@Example.COM");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("user@example.com");
  });

  it("rejects an invalid email", () => {
    expect(Schemas.email.safeParse("not-an-email").success).toBe(false);
    expect(Schemas.email.safeParse("").success).toBe(false);
    expect(Schemas.email.safeParse("@nodomain.com").success).toBe(false);
  });

  it("rejects email longer than 254 characters", () => {
    // 250 + "@b.com" (6) = 256 chars > 254 cap
    const long = "a".repeat(250) + "@b.com";
    expect(Schemas.email.safeParse(long).success).toBe(false);
  });
});

describe("Schemas.id (ObjectId)", () => {
  it("accepts a valid 24-char hex ObjectId", () => {
    expect(Schemas.id.safeParse("507f1f77bcf86cd799439011").success).toBe(true);
  });

  it("rejects non-hex or wrong-length strings", () => {
    expect(Schemas.id.safeParse("short").success).toBe(false);
    expect(Schemas.id.safeParse("507f1f77bcf86cd79943901g").success).toBe(false); // 'g' is not hex
    expect(Schemas.id.safeParse("").success).toBe(false);
  });
});

describe("passwordSchema (via Schemas.password)", () => {
  it("accepts a valid strong password", () => {
    expect(Schemas.password.safeParse("Secure#Pass99").success).toBe(true);
    expect(Schemas.password.safeParse("MyP@ssw0rd!XYZ").success).toBe(true);
  });

  it("rejects password shorter than 8 characters", () => {
    expect(Schemas.password.safeParse("Ab1!").success).toBe(false);
  });

  it("rejects password longer than 128 characters", () => {
    const long = "Aa1!" + "x".repeat(130);
    expect(Schemas.password.safeParse(long).success).toBe(false);
  });

  it("rejects password without an uppercase letter", () => {
    expect(Schemas.password.safeParse("nouppercase1!").success).toBe(false);
  });

  it("rejects password without a lowercase letter", () => {
    expect(Schemas.password.safeParse("NOLOWER1!").success).toBe(false);
  });

  it("rejects password without a number", () => {
    expect(Schemas.password.safeParse("NoNumber!!Aa").success).toBe(false);
  });

  it("rejects password without a special character", () => {
    expect(Schemas.password.safeParse("NoSpecial1Aa").success).toBe(false);
  });

  it("rejects weak/dictionary passwords", () => {
    // Known weak passwords from the blocklist
    expect(Schemas.password.safeParse("Password123").success).toBe(false);
    expect(Schemas.password.safeParse("Admin123").success).toBe(false);
  });

  it("rejects passwords with 4+ repeated characters", () => {
    expect(Schemas.password.safeParse("Aaaa1111!!!!").success).toBe(false);
  });

  it("rejects passwords with sequential characters (4+ char run)", () => {
    // 'abcd' is a 4-char sequential run
    expect(Schemas.password.safeParse("Abcdefg1!").success).toBe(false);
    // '1234' is a 4-char sequential run
    expect(Schemas.password.safeParse("Test1234!").success).toBe(false);
  });
});

describe("Schemas.phone", () => {
  it("accepts a valid Indian phone number", () => {
    const result = Schemas.phone.safeParse({ phoneCc: "+91", phone: "9876543210" });
    expect(result.success).toBe(true);
  });

  it("accepts a valid international phone number", () => {
    const result = Schemas.phone.safeParse({ phoneCc: "+1", phone: "2025551234" });
    expect(result.success).toBe(true);
  });

  it("rejects Indian number not starting with 6-9", () => {
    const result = Schemas.phone.safeParse({ phoneCc: "+91", phone: "5876543210" });
    expect(result.success).toBe(false);
  });

  it("rejects Indian number that is not exactly 10 digits", () => {
    const result = Schemas.phone.safeParse({ phoneCc: "+91", phone: "987654321" }); // 9 digits
    expect(result.success).toBe(false);
  });

  it("rejects non-numeric phone", () => {
    const result = Schemas.phone.safeParse({ phoneCc: "+91", phone: "abcdefghij" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid country code", () => {
    const result = Schemas.phone.safeParse({ phoneCc: "91", phone: "9876543210" }); // missing '+'
    expect(result.success).toBe(false);
  });
});

describe("Schemas.address", () => {
  const validAddress = {
    line1: "123 Main Street",
    city: "Mumbai",
    state: "Maharashtra",
    country: "IN",
    zipcode: "400001",
  };

  it("accepts a valid address", () => {
    expect(Schemas.address.safeParse(validAddress).success).toBe(true);
  });

  it("rejects address with a non-2-letter country code", () => {
    const bad = { ...validAddress, country: "IND" };
    expect(Schemas.address.safeParse(bad).success).toBe(false);
  });

  it("rejects address with invalid zipcode", () => {
    const bad = { ...validAddress, zipcode: "!" };
    expect(Schemas.address.safeParse(bad).success).toBe(false);
  });

  it("rejects address with too-short line1", () => {
    const bad = { ...validAddress, line1: "A" };
    expect(Schemas.address.safeParse(bad).success).toBe(false);
  });
});

describe("Schemas.adminUserUpdate", () => {
  it("accepts valid userId and role", () => {
    const result = Schemas.adminUserUpdate.safeParse({
      userId: "507f1f77bcf86cd799439011",
      role: "user",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown role values", () => {
    const result = Schemas.adminUserUpdate.safeParse({
      userId: "507f1f77bcf86cd799439011",
      role: "superadmin",
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields (strict mode)", () => {
    const result = Schemas.adminUserUpdate.safeParse({
      userId: "507f1f77bcf86cd799439011",
      role: "admin",
      email: "hack@example.com", // extra field
    });
    expect(result.success).toBe(false);
  });
});

describe("Schemas.dnsRecord", () => {
  const baseRecord = { type: "A", name: "example.com", value: "1.2.3.4", ttl: 3600 };

  it("accepts a valid A record", () => {
    expect(Schemas.dnsRecord.safeParse(baseRecord).success).toBe(true);
  });

  it("accepts a valid MX record with priority", () => {
    const mx = { type: "MX", name: "@", value: "mail.example.com", ttl: 3600, priority: 10 };
    expect(Schemas.dnsRecord.safeParse(mx).success).toBe(true);
  });

  it("rejects an unknown DNS record type", () => {
    const bad = { ...baseRecord, type: "SPF" };
    expect(Schemas.dnsRecord.safeParse(bad).success).toBe(false);
  });

  it("rejects ttl below 60", () => {
    const bad = { ...baseRecord, ttl: 30 };
    expect(Schemas.dnsRecord.safeParse(bad).success).toBe(false);
  });

  it("rejects ttl above 86400", () => {
    const bad = { ...baseRecord, ttl: 100000 };
    expect(Schemas.dnsRecord.safeParse(bad).success).toBe(false);
  });
});

describe("Schemas.registration", () => {
  const validReg = {
    email: "user@example.com",
    password: "Secure#Pass99",
    firstName: "Test",
    lastName: "User",
    whatsappNumber: "9876543210",
    phone: "9876543210",
    phoneCc: "+91",
    address: {
      line1: "123 Main Street",
      city: "Mumbai",
      state: "Maharashtra",
      country: "India",
      zipcode: "400001",
    },
  };

  it("accepts a complete valid registration object", () => {
    expect(Schemas.registration.safeParse(validReg).success).toBe(true);
  });

  it("rejects registration without required firstName", () => {
    const { firstName: _, ...bad } = validReg;
    expect(Schemas.registration.safeParse(bad).success).toBe(false);
  });

  it("rejects registration with an invalid email", () => {
    const bad = { ...validReg, email: "not-valid" };
    expect(Schemas.registration.safeParse(bad).success).toBe(false);
  });

  it("rejects registration with a weak password", () => {
    const bad = { ...validReg, password: "Password123" };
    expect(Schemas.registration.safeParse(bad).success).toBe(false);
  });

  it("rejects registration without a WhatsApp number (now required)", () => {
    const { whatsappNumber: _w, ...bad } = validReg;
    expect(Schemas.registration.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-10-digit WhatsApp number", () => {
    expect(Schemas.registration.safeParse({ ...validReg, whatsappNumber: "12345" }).success).toBe(false);
  });
});

describe("Schemas.domainName", () => {
  it("accepts valid domain names", () => {
    expect(Schemas.domainName.safeParse("example.com").success).toBe(true);
    expect(Schemas.domainName.safeParse("sub.example.co.in").success).toBe(true);
    expect(Schemas.domainName.safeParse("my-domain.org").success).toBe(true);
  });

  it("rejects domain names starting with a hyphen", () => {
    expect(Schemas.domainName.safeParse("-bad.com").success).toBe(false);
  });

  it("rejects domains without a TLD", () => {
    expect(Schemas.domainName.safeParse("nodot").success).toBe(false);
  });
});

// ─── InputValidator class ────────────────────────────────────────────────────

describe("InputValidator.validateEmail", () => {
  it("accepts and normalizes a valid email", () => {
    const r = InputValidator.validateEmail("  Test@Example.COM  ");
    expect(r.isValid).toBe(true);
    expect(r.sanitized).toBe("test@example.com");
  });

  it("rejects an empty email", () => {
    const r = InputValidator.validateEmail("");
    expect(r.isValid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("rejects an email over 1000 characters (overflow protection)", () => {
    const r = InputValidator.validateEmail("a".repeat(1001));
    expect(r.isValid).toBe(false);
    expect(r.errors[0]).toMatch(/too large/i);
  });
});

describe("InputValidator.validatePassword", () => {
  it("accepts a strong password", () => {
    const r = InputValidator.validatePassword("MyStr0ngP@ss");
    expect(r.isValid).toBe(true);
  });

  it("rejects a password shorter than 8 characters", () => {
    const r = InputValidator.validatePassword("Ab1!");
    expect(r.isValid).toBe(false);
  });

  it("rejects a known weak password", () => {
    const r = InputValidator.validatePassword("password");
    expect(r.isValid).toBe(false);
    expect(r.errors[0]).toMatch(/weak/i);
  });
});

describe("InputValidator.validatePasswordStrength", () => {
  it("accepts a password that passes all strength checks", () => {
    const r = InputValidator.validatePasswordStrength("MyStr0ngP@ss!");
    expect(r.isValid).toBe(true);
  });

  it("reports multiple errors for a very weak password", () => {
    const r = InputValidator.validatePasswordStrength("weak");
    expect(r.isValid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(1);
  });

  it("rejects passwords with 4+ repeated characters", () => {
    // "aaaa" is 4 consecutive same-case chars → triggers /(.)\1{3,}/
    const r = InputValidator.validatePasswordStrength("Testaaaa1!Pass");
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => e.includes("repeated"))).toBe(true);
  });

  it("rejects passwords with sequential characters", () => {
    const r = InputValidator.validatePasswordStrength("Abcde12!PASS");
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => e.includes("sequential"))).toBe(true);
  });
});

describe("InputValidator.validateName", () => {
  it("accepts a valid name", () => {
    const r = InputValidator.validateName("John", "First Name");
    expect(r.isValid).toBe(true);
    expect(r.sanitized).toBe("John");
  });

  it("rejects a name shorter than 2 characters", () => {
    const r = InputValidator.validateName("A");
    expect(r.isValid).toBe(false);
  });

  it("rejects a name with numbers", () => {
    const r = InputValidator.validateName("John123");
    expect(r.isValid).toBe(false);
  });

  it("rejects an empty name", () => {
    const r = InputValidator.validateName("");
    expect(r.isValid).toBe(false);
  });
});

describe("InputValidator.validateDomainName", () => {
  it("accepts a valid domain name", () => {
    const r = InputValidator.validateDomainName("example.com");
    expect(r.isValid).toBe(true);
    expect(r.sanitized).toBe("example.com");
  });

  it("strips whitespace and lowercases", () => {
    const r = InputValidator.validateDomainName("  EXAMPLE.COM  ");
    expect(r.isValid).toBe(true);
    expect(r.sanitized).toBe("example.com");
  });

  it("accepts a 2-character domain label (e.g. 'ff') — short labels are valid", () => {
    const r = InputValidator.validateDomainName("ff");
    expect(r.isValid).toBe(true);
  });

  it("rejects an empty domain", () => {
    const r = InputValidator.validateDomainName("");
    expect(r.isValid).toBe(false);
  });
});

describe("InputValidator.validateObjectId", () => {
  it("accepts a valid MongoDB ObjectId", () => {
    const r = InputValidator.validateObjectId("507f1f77bcf86cd799439011");
    expect(r.isValid).toBe(true);
  });

  it("rejects an invalid ObjectId", () => {
    const r = InputValidator.validateObjectId("not-an-objectid");
    expect(r.isValid).toBe(false);
  });

  it("rejects an empty string", () => {
    const r = InputValidator.validateObjectId("");
    expect(r.isValid).toBe(false);
  });
});

describe("InputValidator.sanitizeHtml", () => {
  it("escapes HTML special characters", () => {
    const result = InputValidator.sanitizeHtml('<script>alert("xss")</script>');
    expect(result).not.toContain("<");
    expect(result).not.toContain(">");
    expect(result).toContain("&lt;");
    expect(result).toContain("&gt;");
  });

  it("escapes double quotes", () => {
    expect(InputValidator.sanitizeHtml('"hello"')).toContain("&quot;");
  });
});

describe("InputValidator.validatePhone", () => {
  it("accepts a valid Indian mobile number", () => {
    const r = InputValidator.validatePhone("9876543210", "+91");
    expect(r.isValid).toBe(true);
  });

  it("accepts a valid international number", () => {
    const r = InputValidator.validatePhone("2025551234", "+1");
    expect(r.isValid).toBe(true);
  });

  it("rejects an Indian number that is not 10 digits", () => {
    const r = InputValidator.validatePhone("987654321", "+91"); // 9 digits
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => e.includes("10 digits"))).toBe(true);
  });

  it("rejects an Indian number not starting with 6-9", () => {
    const r = InputValidator.validatePhone("5876543210", "+91");
    expect(r.isValid).toBe(false);
  });

  it("rejects a phone number with letters", () => {
    const r = InputValidator.validatePhone("ABCDEFGHIJ");
    expect(r.isValid).toBe(false);
  });

  it("rejects an empty phone number", () => {
    const r = InputValidator.validatePhone("");
    expect(r.isValid).toBe(false);
  });

  it("rejects a phone number over 50 characters (overflow protection)", () => {
    const r = InputValidator.validatePhone("9".repeat(51));
    expect(r.isValid).toBe(false);
    expect(r.errors[0]).toMatch(/too long/i);
  });
});

describe("InputValidator.validatePhoneCc", () => {
  it("accepts +91 (India)", () => {
    expect(InputValidator.validatePhoneCc("+91").isValid).toBe(true);
  });

  it("accepts +1 (USA)", () => {
    expect(InputValidator.validatePhoneCc("+1").isValid).toBe(true);
  });

  it("accepts +44 (UK)", () => {
    expect(InputValidator.validatePhoneCc("+44").isValid).toBe(true);
  });

  it("rejects a code without the leading '+'", () => {
    expect(InputValidator.validatePhoneCc("91").isValid).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(InputValidator.validatePhoneCc("").isValid).toBe(false);
  });

  it("rejects a code over 10 characters", () => {
    expect(InputValidator.validatePhoneCc("+91234567890").isValid).toBe(false);
  });
});

describe("InputValidator.validateAddress", () => {
  const validAddress = {
    line1: "123 Main Street",
    city: "Mumbai",
    state: "Maharashtra",
    country: "IN",
    zipcode: "400001",
  };

  it("accepts a valid address object", () => {
    const r = InputValidator.validateAddress(validAddress);
    expect(r.isValid).toBe(true);
  });

  it("rejects a non-object input", () => {
    const r = InputValidator.validateAddress(null as any);
    expect(r.isValid).toBe(false);
  });

  it("rejects when required city is missing", () => {
    const bad = { ...validAddress, city: "" };
    const r = InputValidator.validateAddress(bad);
    expect(r.isValid).toBe(false);
  });

  it("rejects when country is not a 2-letter code", () => {
    const bad = { ...validAddress, country: "India" };
    const r = InputValidator.validateAddress(bad);
    expect(r.isValid).toBe(false);
  });

  it("rejects when zipcode has an invalid format", () => {
    const bad = { ...validAddress, zipcode: "!!" };
    const r = InputValidator.validateAddress(bad);
    expect(r.isValid).toBe(false);
  });

  it("rejects when any field is too short", () => {
    const bad = { ...validAddress, line1: "A" }; // < 2 chars
    const r = InputValidator.validateAddress(bad);
    expect(r.isValid).toBe(false);
  });
});

describe("InputValidator.validateMessage", () => {
  it("accepts a valid message", () => {
    const r = InputValidator.validateMessage("This is a valid contact message with enough length.");
    expect(r.isValid).toBe(true);
  });

  it("rejects an empty message", () => {
    const r = InputValidator.validateMessage("");
    expect(r.isValid).toBe(false);
  });

  it("rejects a message shorter than 10 characters", () => {
    const r = InputValidator.validateMessage("Hi");
    expect(r.isValid).toBe(false);
  });

  it("rejects a message longer than 2000 characters", () => {
    const r = InputValidator.validateMessage("A".repeat(2001));
    expect(r.isValid).toBe(false);
  });

  it("rejects an oversized message (overflow protection > 10000 chars)", () => {
    const r = InputValidator.validateMessage("A".repeat(10001));
    expect(r.isValid).toBe(false);
    expect(r.errors[0]).toMatch(/too large/i);
  });

  it("uses a custom field name in error messages", () => {
    const r = InputValidator.validateMessage("", "Feedback");
    expect(r.errors[0]).toContain("Feedback");
  });
});

describe("InputValidator.validateDomainIds", () => {
  it("accepts an array of valid ObjectIds", () => {
    const r = InputValidator.validateDomainIds([
      "507f1f77bcf86cd799439011",
      "507f1f77bcf86cd799439012",
    ]);
    expect(r.isValid).toBe(true);
  });

  it("rejects a non-array", () => {
    const r = InputValidator.validateDomainIds("not-array");
    expect(r.isValid).toBe(false);
  });

  it("rejects an empty array", () => {
    const r = InputValidator.validateDomainIds([]);
    expect(r.isValid).toBe(false);
  });

  it("rejects an array with more than 10 items", () => {
    const ids = Array(11).fill("507f1f77bcf86cd799439011");
    const r = InputValidator.validateDomainIds(ids);
    expect(r.isValid).toBe(false);
  });

  it("rejects an array containing an invalid ObjectId", () => {
    const r = InputValidator.validateDomainIds(["not-valid", "507f1f77bcf86cd799439011"]);
    expect(r.isValid).toBe(false);
  });
});
