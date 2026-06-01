/**
 * Tests for `@/lib/security/validator` (rescan-4 slice 7eg).
 * SecurityValidator static-only facade. Pins:
 *  - containsMaliciousPatterns flags SQL keywords, NoSQL operators ($where,
 *    $ne, $regex, …), XSS (<script>, javascript:, on*=), command injection,
 *    path traversal (../, ..\\, %2f variants), null byte, control chars
 *  - validateFileUpload rejects 18 dangerous extensions verbatim
 *  - validateFileUpload short-circuits on >10MB content WITHOUT running
 *    the regex set (the in-code warning notes the regex stack-overflows
 *    on huge inputs)
 *  - sanitizeInput honours maxLength (default 1000), allowHtml (strips
 *    <tags>), allowSpecialChars, normalises whitespace
 *  - validateEmailSecurity rejects > 254 chars + suspicious patterns
 *    (`..` / `@.` / `.@`)
 *  - validatePasswordSecurity strength tiers: <8 weak/error, 8-11 medium,
 *    12+ strong; rejects 9 common patterns (123456, password, admin, ...)
 *  - **validateCSRF dual-layer defense**:
 *    - GET/HEAD/OPTIONS bypass (safe methods)
 *    - Origin match wins; mismatch fails
 *    - Referer fallback when no Origin; startsWith check
 *    - **Production with no Origin AND no Referer → fails** (head-less
 *      request guard); dev without headers passes (curl-friendly)
 *    - NEXTAUTH_URL unset → fails with config error
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SecurityValidator } from "@/lib/security/validator";

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_URL", "https://app.test.example");
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function csrfReq(opts: {
  method?: string;
  origin?: string;
  referer?: string;
}): Request {
  const headers = new Headers();
  if (opts.origin) headers.set("origin", opts.origin);
  if (opts.referer) headers.set("referer", opts.referer);
  return new Request("https://test/", {
    method: opts.method ?? "POST",
    headers,
  });
}

describe("containsMaliciousPatterns", () => {
  it("flags SQL-injection keywords", () => {
    const result = SecurityValidator.containsMaliciousPatterns(
      "1' OR 1=1; DROP TABLE users; --"
    );
    expect(result.isMalicious).toBe(true);
    expect(result.patterns.length).toBeGreaterThan(0);
  });

  it("flags NoSQL $where + $ne operators", () => {
    expect(
      SecurityValidator.containsMaliciousPatterns('{"username": {"$ne": null}}')
        .isMalicious
    ).toBe(true);
    expect(
      SecurityValidator.containsMaliciousPatterns('{"$where": "this.x==1"}')
        .isMalicious
    ).toBe(true);
  });

  it("flags XSS <script> + javascript: + on*= handlers", () => {
    expect(
      SecurityValidator.containsMaliciousPatterns('<script>alert(1)</script>')
        .isMalicious
    ).toBe(true);
    expect(
      SecurityValidator.containsMaliciousPatterns('href="javascript:evil()"')
        .isMalicious
    ).toBe(true);
    expect(
      SecurityValidator.containsMaliciousPatterns('<img onerror=x>').isMalicious
    ).toBe(true);
  });

  it("flags path-traversal ../ + %2f variants", () => {
    expect(
      SecurityValidator.containsMaliciousPatterns("../../etc/passwd").isMalicious
    ).toBe(true);
    expect(
      SecurityValidator.containsMaliciousPatterns("..%2fadmin").isMalicious
    ).toBe(true);
  });

  it("flags null byte (\\x00)", () => {
    expect(
      SecurityValidator.containsMaliciousPatterns("safe\x00../etc/passwd")
        .isMalicious
    ).toBe(true);
  });

  it("the 'sanitized' field has matched substrings progressively stripped (multi-pattern pass)", () => {
    // The SQL pattern strips the literal word 'SCRIPT', then the generic
    // XML <[^>]*> pattern strips the bare angle brackets that remain.
    // Inner content survives — this is documented as defence-in-depth,
    // not a hermetic strip.
    const result = SecurityValidator.containsMaliciousPatterns(
      "<script>x</script>hello"
    );
    expect(result.isMalicious).toBe(true);
    expect(result.sanitized).not.toContain("<");
    expect(result.sanitized).not.toContain(">");
  });
});

describe("validateFileUpload", () => {
  it("rejects dangerous extensions (.exe, .bat, .sh, etc.)", () => {
    expect(SecurityValidator.validateFileUpload("malware.exe", "ok").isValid).toBe(false);
    expect(SecurityValidator.validateFileUpload("script.sh", "ok").isValid).toBe(false);
    expect(SecurityValidator.validateFileUpload("config.htaccess", "ok").isValid).toBe(false);
  });

  it("accepts a benign extension + clean content", () => {
    expect(
      SecurityValidator.validateFileUpload("doc.pdf", "clean ascii content").isValid
    ).toBe(true);
  });

  it("short-circuits on >10MB content WITHOUT scanning patterns (regex stack-overflow guard)", () => {
    const huge = "x".repeat(10 * 1024 * 1024 + 1);
    const result = SecurityValidator.validateFileUpload("big.pdf", huge);
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => /size/i.test(e))).toBe(true);
  });
});

describe("sanitizeInput", () => {
  it("default maxLength=1000 → longer inputs truncated", () => {
    const result = SecurityValidator.sanitizeInput("a".repeat(2000));
    expect(result.length).toBeLessThanOrEqual(1000);
  });

  it("allowHtml:false (default) strips <tags>", () => {
    // Pre-strips malicious-patterns first; then secondary HTML strip
    // catches anything non-malicious that survives.
    const result = SecurityValidator.sanitizeInput("<b>bold</b> text");
    expect(result).not.toMatch(/<\/?b>/);
  });

  it("allowSpecialChars:false leaves only alnum + space + -_.", () => {
    const result = SecurityValidator.sanitizeInput("hello@world!", {
      allowSpecialChars: false,
    });
    expect(result).not.toMatch(/[@!]/);
  });

  it("normalises whitespace + trims", () => {
    const result = SecurityValidator.sanitizeInput("  hello   world  ");
    expect(result).toBe("hello world");
  });
});

describe("validateEmailSecurity", () => {
  it("accepts a clean valid email + lowercases the sanitized form", () => {
    const result = SecurityValidator.validateEmailSecurity("Alice@Example.Com");
    expect(result.isValid).toBe(true);
    expect(result.sanitized).toBe("alice@example.com");
  });

  it("rejects invalid format", () => {
    expect(SecurityValidator.validateEmailSecurity("no-at-sign").isValid).toBe(false);
  });

  it("rejects suspicious patterns: `..` / `@.` / `.@`", () => {
    expect(SecurityValidator.validateEmailSecurity("a..b@x.test").isValid).toBe(false);
    expect(SecurityValidator.validateEmailSecurity("a@.test").isValid).toBe(false);
    expect(SecurityValidator.validateEmailSecurity("a.@test.com").isValid).toBe(false);
  });

  it("rejects >254 chars", () => {
    const local = "a".repeat(250);
    expect(
      SecurityValidator.validateEmailSecurity(`${local}@b.test`).isValid
    ).toBe(false);
  });
});

describe("validatePasswordSecurity strength tiers + common-pattern rejection", () => {
  it("<8 chars → weak + error", () => {
    const result = SecurityValidator.validatePasswordSecurity("Aa1#");
    expect(result.strength).toBe("weak");
    expect(result.isValid).toBe(false);
  });

  it("8-11 chars + variety → medium", () => {
    const result = SecurityValidator.validatePasswordSecurity("Aa1#bbcc");
    expect(result.strength).toBe("medium");
  });

  it("12+ chars + variety → strong + valid", () => {
    const result = SecurityValidator.validatePasswordSecurity("Aa1#bbcc1234");
    expect(result.strength).toBe("strong");
    expect(result.isValid).toBe(true);
  });

  it("missing each char class → respective error", () => {
    const noUpper = SecurityValidator.validatePasswordSecurity("aaaaaa1!").errors;
    expect(noUpper.some((e) => /uppercase/i.test(e))).toBe(true);

    const noLower = SecurityValidator.validatePasswordSecurity("AAAAAA1!").errors;
    expect(noLower.some((e) => /lowercase/i.test(e))).toBe(true);

    const noNumber = SecurityValidator.validatePasswordSecurity("Aaaaaaa!").errors;
    expect(noNumber.some((e) => /number/i.test(e))).toBe(true);

    const noSpecial = SecurityValidator.validatePasswordSecurity("Aaaaaaa1").errors;
    expect(noSpecial.some((e) => /special/i.test(e))).toBe(true);
  });

  it("flags common dictionary patterns (password / admin / qwerty / 123456)", () => {
    const result1 = SecurityValidator.validatePasswordSecurity("Password1#");
    expect(result1.errors.some((e) => /common/i.test(e))).toBe(true);

    const result2 = SecurityValidator.validatePasswordSecurity("Admin1234#");
    expect(result2.errors.some((e) => /common/i.test(e))).toBe(true);

    const result3 = SecurityValidator.validatePasswordSecurity("Qwerty1#");
    expect(result3.errors.some((e) => /common/i.test(e))).toBe(true);
  });
});

describe("validateCSRF — dual-layer defense", () => {
  it("safe methods (GET/HEAD/OPTIONS) bypass the check entirely", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(SecurityValidator.validateCSRF(csrfReq({ method })).isValid).toBe(true);
    }
  });

  it("Origin match → pass", () => {
    expect(
      SecurityValidator.validateCSRF(
        csrfReq({ origin: "https://app.test.example" })
      ).isValid
    ).toBe(true);
  });

  it("Origin MISMATCH → fail with 'CSRF: Origin mismatch'", () => {
    const result = SecurityValidator.validateCSRF(
      csrfReq({ origin: "https://evil.example" })
    );
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("CSRF: Origin mismatch");
  });

  it("no Origin → Referer fallback (startsWith)", () => {
    expect(
      SecurityValidator.validateCSRF(
        csrfReq({ referer: "https://app.test.example/login" })
      ).isValid
    ).toBe(true);
  });

  it("no Origin + Referer mismatch → fail", () => {
    const result = SecurityValidator.validateCSRF(
      csrfReq({ referer: "https://evil.example/x" })
    );
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("CSRF: Referer mismatch");
  });

  it("PRODUCTION + no Origin + no Referer → fail (head-less request guard)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const result = SecurityValidator.validateCSRF(csrfReq({}));
    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(/Missing security headers/);
  });

  it("DEV + no Origin + no Referer → pass (curl-friendly)", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(SecurityValidator.validateCSRF(csrfReq({})).isValid).toBe(true);
  });

  it("NEXTAUTH_URL unset → fail with config error", () => {
    vi.stubEnv("NEXTAUTH_URL", "");
    vi.stubEnv("APP_URL", "");
    const result = SecurityValidator.validateCSRF(
      csrfReq({ origin: "https://anything" })
    );
    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(/NEXTAUTH_URL.*not configured/);
  });
});
