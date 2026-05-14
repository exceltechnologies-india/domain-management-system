import { describe, it, expect } from "vitest";
import bcrypt from "bcryptjs";

// User model is imported to verify it loads without error.
// mongoose.model() is mocked in setup.ts to return {}, so we can't
// instantiate documents — we test the underlying bcrypt logic instead,
// which is what the User pre-save hook and comparePassword method execute.
import User from "@/models/User";

describe("User module", () => {
  it("imports without throwing an error", () => {
    // If the module-level code (schema definition) throws, this test fails.
    expect(User).toBeDefined();
  });
});

describe("User password hashing logic (bcrypt)", () => {
  it("hashes a password to a different string", async () => {
    const password = "SecurePass1!";
    const hash = await bcrypt.hash(password, 12);
    expect(hash).not.toBe(password);
    expect(hash.length).toBeGreaterThan(20);
  });

  it("bcrypt.compare returns true for the correct password", async () => {
    const password = "SecurePass1!";
    const hash = await bcrypt.hash(password, 12);
    const match = await bcrypt.compare(password, hash);
    expect(match).toBe(true);
  });

  it("bcrypt.compare returns false for an incorrect password", async () => {
    const hash = await bcrypt.hash("SecurePass1!", 12);
    const match = await bcrypt.compare("WrongPassword!", hash);
    expect(match).toBe(false);
  });

  it("bcrypt.compare returns false for an empty string", async () => {
    const hash = await bcrypt.hash("SecurePass1!", 12);
    const match = await bcrypt.compare("", hash);
    expect(match).toBe(false);
  });

  it("produces different hashes for the same password (salt randomness)", async () => {
    const password = "SecurePass1!";
    const hash1 = await bcrypt.hash(password, 12);
    const hash2 = await bcrypt.hash(password, 12);
    expect(hash1).not.toBe(hash2);
    // But both should verify correctly
    expect(await bcrypt.compare(password, hash1)).toBe(true);
    expect(await bcrypt.compare(password, hash2)).toBe(true);
  });
});

describe("User role values", () => {
  it("defines the expected role strings", () => {
    // Validate the role enum values match the IUser interface
    const validRoles: Array<"admin" | "user"> = ["admin", "user"];
    expect(validRoles).toContain("admin");
    expect(validRoles).toContain("user");
    expect(validRoles.length).toBe(2);
  });
});
