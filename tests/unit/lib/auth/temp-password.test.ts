/** One-time password for a new Customer Portal account (7 Oct 2026). */
import { describe, it, expect } from "vitest";
import { generateTempPassword } from "@/lib/auth/temp-password";
import { InputValidator } from "@/lib/validation";

describe("generateTempPassword", () => {
  const many = Array.from({ length: 300 }, () => generateTempPassword());
  it("is three groups of four, readable, with no look-alike characters", () => {
    for (const p of many) {
      expect(p).toMatch(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);
      expect(p).not.toMatch(/[01OlI]/);
    }
  });
  it("passes the portal's own strength rule", () => {
    for (const p of many) expect(InputValidator.validatePasswordStrength(p).isValid).toBe(true);
  });
  it("is different every time", () => {
    expect(new Set(many).size).toBe(many.length);
  });
});
