import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SecurityValidator } from "@/lib/security";

describe("SecurityValidator.containsMaliciousPatterns", () => {
  it("flags SQL injection keywords", () => {
    const r = SecurityValidator.containsMaliciousPatterns(
      "SELECT * FROM users WHERE id = 1"
    );
    expect(r.isMalicious).toBe(true);
    expect(r.patterns.length).toBeGreaterThan(0);
  });

  it("flags classic SQL tautology", () => {
    expect(
      SecurityValidator.containsMaliciousPatterns("admin' OR 1=1 --").isMalicious
    ).toBe(true);
  });

  it("flags <script> XSS payload", () => {
    const r = SecurityValidator.containsMaliciousPatterns(
      "<script>alert('xss')</script>"
    );
    expect(r.isMalicious).toBe(true);
    expect(r.sanitized).not.toContain("<script");
  });

  it("flags javascript: URL", () => {
    expect(
      SecurityValidator.containsMaliciousPatterns("javascript:alert(1)").isMalicious
    ).toBe(true);
  });

  it("flags onerror= event handler injection", () => {
    expect(
      SecurityValidator.containsMaliciousPatterns(
        "<img src=x onerror=alert(1) />"
      ).isMalicious
    ).toBe(true);
  });

  it("flags NoSQL $ne operator", () => {
    expect(
      SecurityValidator.containsMaliciousPatterns('{"username":{"$ne":null}}').isMalicious
    ).toBe(true);
  });

  it("flags path traversal sequences", () => {
    expect(
      SecurityValidator.containsMaliciousPatterns("../../etc/passwd").isMalicious
    ).toBe(true);
  });

  it("flags URL-encoded path traversal", () => {
    expect(
      SecurityValidator.containsMaliciousPatterns("..%2fetc%2fpasswd").isMalicious
    ).toBe(true);
  });

  it("flags null byte injection", () => {
    expect(
      SecurityValidator.containsMaliciousPatterns("file.txt\x00.exe").isMalicious
    ).toBe(true);
  });

  it("flags command-injection metacharacters", () => {
    // Semicolons, pipes, backticks all trigger the command-shell pattern.
    expect(
      SecurityValidator.containsMaliciousPatterns("ls; rm -rf /").isMalicious
    ).toBe(true);
  });

  it("returns sanitized output with the matched fragments removed", () => {
    const r = SecurityValidator.containsMaliciousPatterns(
      "hello <script>steal()</script> world"
    );
    expect(r.isMalicious).toBe(true);
    expect(r.sanitized).not.toContain("<script>");
    expect(r.sanitized).not.toContain("</script>");
  });
});

describe("SecurityValidator.validateFileUpload", () => {
  it("rejects .exe files outright", () => {
    const r = SecurityValidator.validateFileUpload("hax.exe", "binary");
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => e.includes(".exe"))).toBe(true);
  });

  it("rejects .bat, .cmd, .sh, .php as dangerous", () => {
    for (const ext of [".bat", ".cmd", ".sh", ".php"]) {
      const r = SecurityValidator.validateFileUpload(`foo${ext}`, "anything");
      expect(r.isValid).toBe(false);
    }
  });

  it("rejects content larger than 10 MB", () => {
    const big = "x".repeat(10 * 1024 * 1024 + 1);
    const r = SecurityValidator.validateFileUpload("ok.txt", big);
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes("size"))).toBe(true);
  });

  it("rejects malicious content even with a clean filename", () => {
    const r = SecurityValidator.validateFileUpload(
      "ok.txt",
      "<script>alert(1)</script>"
    );
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes("malicious"))).toBe(true);
  });

  it("rejects path-traversal filenames", () => {
    const r = SecurityValidator.validateFileUpload(
      "../../etc/passwd",
      "harmless"
    );
    expect(r.isValid).toBe(false);
  });
});

describe("SecurityValidator.sanitizeInput", () => {
  it("strips HTML when allowHtml is false (default)", () => {
    const out = SecurityValidator.sanitizeInput("<b>hello</b> world");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).toContain("hello");
    expect(out).toContain("world");
  });

  it("truncates to maxLength", () => {
    const out = SecurityValidator.sanitizeInput("abcdefghij", { maxLength: 4 });
    expect(out.length).toBeLessThanOrEqual(4);
  });

  it("collapses repeated whitespace and trims", () => {
    const out = SecurityValidator.sanitizeInput("  hello   there  ");
    expect(out).toBe("hello there");
  });

  it("strips non-alphanumeric chars when allowSpecialChars is false", () => {
    const out = SecurityValidator.sanitizeInput("hi! @world #1", {
      allowSpecialChars: false,
    });
    expect(out).not.toContain("!");
    expect(out).not.toContain("@");
    expect(out).not.toContain("#");
  });
});

describe("SecurityValidator.validateEmailSecurity", () => {
  it("accepts a normal address", () => {
    const r = SecurityValidator.validateEmailSecurity("user@example.com");
    expect(r.isValid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("rejects an address with no @", () => {
    expect(SecurityValidator.validateEmailSecurity("notanemail").isValid).toBe(
      false
    );
  });

  it("rejects double-dot patterns", () => {
    expect(
      SecurityValidator.validateEmailSecurity("foo..bar@example.com").isValid
    ).toBe(false);
  });

  it("rejects @. and .@ patterns", () => {
    expect(SecurityValidator.validateEmailSecurity("foo@.com").isValid).toBe(
      false
    );
    expect(SecurityValidator.validateEmailSecurity("foo.@bar.com").isValid).toBe(
      false
    );
  });

  it("rejects emails over 254 chars", () => {
    const long = `${"a".repeat(250)}@b.co`;
    expect(SecurityValidator.validateEmailSecurity(long).isValid).toBe(false);
  });

  it("returns lowercased trimmed sanitized form", () => {
    const r = SecurityValidator.validateEmailSecurity("  USER@Example.COM  ");
    expect(r.sanitized).toBe("user@example.com");
  });
});

describe("SecurityValidator.validatePasswordSecurity", () => {
  it("rejects passwords shorter than 8 chars", () => {
    const r = SecurityValidator.validatePasswordSecurity("Aa1!");
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => e.includes("8 characters"))).toBe(true);
  });

  it("rejects passwords missing uppercase letters", () => {
    const r = SecurityValidator.validatePasswordSecurity("nouppercase1!");
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes("uppercase"))).toBe(true);
  });

  it("rejects passwords missing lowercase letters", () => {
    const r = SecurityValidator.validatePasswordSecurity("NOLOWER1!");
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes("lowercase"))).toBe(true);
  });

  it("rejects passwords missing digits", () => {
    const r = SecurityValidator.validatePasswordSecurity("NoDigits!!");
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes("number"))).toBe(true);
  });

  it("rejects passwords missing special chars", () => {
    const r = SecurityValidator.validatePasswordSecurity("NoSpecial12");
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes("special"))).toBe(true);
  });

  it("flags common dictionary patterns (password, 123456, qwerty…)", () => {
    for (const p of ["MyPassword1!", "Iq123456A!", "qwertyA1!"]) {
      const r = SecurityValidator.validatePasswordSecurity(p);
      expect(r.errors.some((e) => e.toLowerCase().includes("common"))).toBe(true);
    }
  });

  it("classifies 8-11 char passwords with required variety as medium strength", () => {
    const r = SecurityValidator.validatePasswordSecurity("Strg!Pw9");
    expect(r.strength).toBe("medium");
  });

  it("classifies 12+ char passwords with required variety as strong", () => {
    const r = SecurityValidator.validatePasswordSecurity("Strg!Password9");
    expect(r.strength).toBe("strong");
  });
});

describe("SecurityValidator.validateCSRF", () => {
  const ORIGIN = "https://app.anutech.in";
  let originalNextAuthUrl: string | undefined;
  let originalAppUrl: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNextAuthUrl = process.env.NEXTAUTH_URL;
    originalAppUrl = process.env.APP_URL;
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NEXTAUTH_URL = ORIGIN;
  });

  afterEach(() => {
    process.env.NEXTAUTH_URL = originalNextAuthUrl;
    process.env.APP_URL = originalAppUrl;
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
  });

  const makeRequest = (
    method: string,
    headers: Record<string, string> = {}
  ): Request =>
    new Request("https://app.anutech.in/api/x", { method, headers });

  it("skips checks for GET, HEAD, OPTIONS", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"]) {
      expect(SecurityValidator.validateCSRF(makeRequest(m)).isValid).toBe(true);
    }
  });

  it("accepts a POST with matching Origin", () => {
    const r = SecurityValidator.validateCSRF(
      makeRequest("POST", { origin: ORIGIN })
    );
    expect(r.isValid).toBe(true);
  });

  it("rejects a POST with mismatched Origin", () => {
    const r = SecurityValidator.validateCSRF(
      makeRequest("POST", { origin: "https://evil.com" })
    );
    expect(r.isValid).toBe(false);
    expect(r.error).toMatch(/origin/i);
  });

  it("falls back to Referer when Origin is missing", () => {
    const r = SecurityValidator.validateCSRF(
      makeRequest("POST", { referer: `${ORIGIN}/dashboard` })
    );
    expect(r.isValid).toBe(true);
  });

  it("rejects a POST whose Referer points to a different origin", () => {
    const r = SecurityValidator.validateCSRF(
      makeRequest("POST", { referer: "https://evil.com/x" })
    );
    expect(r.isValid).toBe(false);
    expect(r.error).toMatch(/referer/i);
  });

  it("rejects a production POST that has neither Origin nor Referer", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const r = SecurityValidator.validateCSRF(makeRequest("POST"));
    expect(r.isValid).toBe(false);
    expect(r.error).toMatch(/missing/i);
  });

  it("allows a non-production POST without either header (dev convenience)", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    const r = SecurityValidator.validateCSRF(makeRequest("POST"));
    expect(r.isValid).toBe(true);
  });

  it("rejects when NEXTAUTH_URL / APP_URL are both unset", () => {
    delete process.env.NEXTAUTH_URL;
    delete process.env.APP_URL;
    const r = SecurityValidator.validateCSRF(
      makeRequest("POST", { origin: ORIGIN })
    );
    expect(r.isValid).toBe(false);
    expect(r.error).toMatch(/NEXTAUTH_URL/);
  });
});
