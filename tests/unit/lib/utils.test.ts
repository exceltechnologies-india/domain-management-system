/**
 * Tests for `@/lib/utils` (rescan-4 slice 7dd).
 * Two tiny utilities used everywhere:
 *  - cn() — Tailwind class merger (clsx + tailwind-merge)
 *  - getSupportEmail() — env-backed support address
 */
import { describe, it, expect, afterEach } from "vitest";
import { cn, getSupportEmail } from "@/lib/utils";

describe("cn", () => {
  it("joins multiple class names", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("filters falsy values (undefined / null / false / '')", () => {
    expect(cn("a", undefined, null, false, "", "b")).toBe("a b");
  });

  it("supports the clsx object form for conditional classes", () => {
    expect(cn("base", { active: true, inactive: false })).toBe("base active");
  });

  it("uses tailwind-merge to dedupe conflicting Tailwind classes", () => {
    // 'p-2' should win over the earlier 'p-4' (latest wins per twMerge rules).
    expect(cn("p-4", "p-2")).toBe("p-2");
    // 'bg-blue-500' should win over 'bg-red-500'.
    expect(cn("bg-red-500", "bg-blue-500")).toBe("bg-blue-500");
  });
});

describe("getSupportEmail", () => {
  const originalEnv = process.env.SUPPORT_EMAIL;
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SUPPORT_EMAIL;
    } else {
      process.env.SUPPORT_EMAIL = originalEnv;
    }
  });

  it("returns the env var when set", () => {
    process.env.SUPPORT_EMAIL = "ops@example.test";
    expect(getSupportEmail()).toBe("ops@example.test");
  });

  it("falls back to support@anutech.in when SUPPORT_EMAIL is unset", () => {
    delete process.env.SUPPORT_EMAIL;
    expect(getSupportEmail()).toBe("support@anutech.in");
  });
});
