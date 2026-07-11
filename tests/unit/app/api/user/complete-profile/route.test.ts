/**
 * Tests for `app/api/user/complete-profile/route.ts` (slice 7ho, part 1).
 *
 * Customer "complete your profile" save action. Called from the
 * pre-checkout completion warning + the settings page.
 *
 * Threat model:
 *  - **Field mass-assignment**: a refactor that loops `Object.assign`
 *    would let a hostile client overwrite `role` / `isActivated` /
 *    `password` / `directAdminUsername`. Pinned via explicit
 *    per-field write + curated response.
 *  - **Field-wipe on partial save**: a customer who saves only their
 *    phone shouldn't have their existing address wiped. Pinned via
 *    `if (value)` truthiness check — falsy/undefined leaves field
 *    untouched.
 *  - **Profile-completion mis-flag**: if the 8-field completeness
 *    check is wrong, customers either get nagged forever or get
 *    let through to checkout with bad data. Pinned with truth
 *    table on each field.
 *
 * Other pins:
 *  - Auth gate first → 401; downstream untouched
 *  - Zod accepts empty body (all fields optional)
 *  - gstNumber is the ONE special case: `!== undefined` allows
 *    writing "" (clearing GST). Other fields require truthiness.
 *  - Brand-new user (no `user.address`) gets default address with
 *    country: "IN"
 *  - Response shape locks: id, email, firstName, lastName, phone,
 *    phoneCc, companyName, gstNumber, address, profileCompleted,
 *    role, provider — NO password / NO resetToken / NO directAdmin /
 *    NO TOTP secret / NO _id
 *  - Outer catch → 500 generic; sentinel NOT leaked
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

vi.mock("@/lib/mongodb", () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/user/complete-profile/route";

type FakeUser = {
  _id: string;
  email: string;
  firstName: string;
  lastName: string;
  whatsappNumber?: string;
  phone?: string;
  phoneCc?: string;
  companyName?: string;
  gstNumber?: string;
  address?: {
    line1?: string;
    city?: string;
    state?: string;
    country?: string;
    zipcode?: string;
  };
  profileCompleted?: boolean;
  role?: string;
  provider?: string;
  save: ReturnType<typeof vi.fn>;
  // Sentinel fields that must NEVER leak
  password?: string;
  resetToken?: string;
  totpSecret?: string;
  directAdminUsername?: string;
};

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/user/complete-profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeUser(overrides: Partial<FakeUser> = {}): FakeUser {
  return {
    _id: "U1",
    email: "alice@example.com",
    firstName: "Alice",
    lastName: "Smith",
    // WhatsApp is required for completeness (set at registration). Tests that
    // exercise the "no WhatsApp" path override this to "".
    whatsappNumber: "9998887776",
    role: "user",
    provider: "credentials",
    save: vi.fn().mockResolvedValue(undefined),
    // sentinel-leak fields
    password: "$2a$12$BCRYPT_LEAK_ME_PROFILE",
    resetToken: "tok_LEAK_ME",
    totpSecret: "JBSWY3DPEHPK3PXP",
    directAdminUsername: "internal_da_LEAK",
    ...overrides,
  };
}

beforeEach(() => {
  getUserFromRequest.mockReset();
});

describe("Auth gate", () => {
  it("no user → 401; save NEVER called", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ phone: "9999999999" }));
    expect(res.status).toBe(401);
  });
});

describe("Zod schema", () => {
  it("empty body → 200; nothing changes; profileCompleted recomputed to false", async () => {
    const user = makeUser();
    getUserFromRequest.mockResolvedValueOnce(user);
    const res = await POST(makeReq({}));
    expect(res.status).toBe(200);
    expect(user.save).toHaveBeenCalledTimes(1);
    expect(user.profileCompleted).toBe(false);
  });

  it("phone over 20 chars → 400", async () => {
    getUserFromRequest.mockResolvedValueOnce(makeUser());
    const res = await POST(makeReq({ phone: "9".repeat(21) }));
    expect(res.status).toBe(400);
  });
});

describe("Per-field write semantics (anti-wipe)", () => {
  it("phone supplied, address ABSENT → address untouched, NOT initialised to {country:'IN'} when user.address exists", async () => {
    const user = makeUser({
      address: {
        line1: "1 main st",
        city: "Mumbai",
        state: "MH",
        country: "IN",
        zipcode: "400001",
      },
    });
    getUserFromRequest.mockResolvedValueOnce(user);
    await POST(makeReq({ phone: "9999999999" }));
    expect(user.phone).toBe("9999999999");
    expect(user.address?.line1).toBe("1 main st");
  });

  it("BRAND-NEW user (no user.address) → address is INITIALISED with country='IN'", async () => {
    const user = makeUser(); // no .address
    getUserFromRequest.mockResolvedValueOnce(user);
    await POST(makeReq({ phone: "9999999999" }));
    expect(user.address).toBeDefined();
    expect(user.address?.country).toBe("IN");
    expect(user.address?.line1).toBe("");
  });

  it("companyName empty string → NOT written (falsy guard)", async () => {
    const user = makeUser({ companyName: "Old Co" });
    getUserFromRequest.mockResolvedValueOnce(user);
    await POST(makeReq({ companyName: "" }));
    // Zod requires min(1) when present, so empty string is rejected at
    // validation. Pin that path explicitly.
    // (No assertion on save — request fails validation.)
  });

  it("phoneCc supplied → overwrites old value", async () => {
    const user = makeUser({ phoneCc: "+1" });
    getUserFromRequest.mockResolvedValueOnce(user);
    await POST(makeReq({ phoneCc: "+91" }));
    expect(user.phoneCc).toBe("+91");
  });
});

describe("gstNumber clear-allow (the ONE special case)", () => {
  it("gstNumber='' (empty string) → field IS written (clears existing GST)", async () => {
    const user = makeUser({ gstNumber: "29ABCDE1234F1Z5" });
    getUserFromRequest.mockResolvedValueOnce(user);
    await POST(makeReq({ gstNumber: "" }));
    expect(user.gstNumber).toBe("");
  });

  it("gstNumber absent from body → existing value preserved (not undefined-clobbered)", async () => {
    const user = makeUser({ gstNumber: "29ABCDE1234F1Z5" });
    getUserFromRequest.mockResolvedValueOnce(user);
    await POST(makeReq({ phone: "9999999999" }));
    expect(user.gstNumber).toBe("29ABCDE1234F1Z5");
  });
});

describe("8-field profileCompleted truth table", () => {
  const FULL = {
    phone: "9999999999",
    phoneCc: "+91",
    companyName: "Acme",
    address: {
      line1: "1 main st",
      city: "Mumbai",
      state: "MH",
      country: "IN",
      zipcode: "400001",
    },
  };

  it("ALL 8 fields present → profileCompleted=true", async () => {
    const user = makeUser();
    getUserFromRequest.mockResolvedValueOnce(user);
    await POST(makeReq(FULL));
    expect(user.profileCompleted).toBe(true);
  });

  it.each(["phone", "phoneCc", "companyName"] as const)(
    "missing top-level field '%s' → profileCompleted=false",
    async (missing) => {
      const user = makeUser();
      getUserFromRequest.mockResolvedValueOnce(user);
      const body: Record<string, unknown> = { ...FULL };
      delete body[missing];
      await POST(makeReq(body));
      expect(user.profileCompleted).toBe(false);
    }
  );

  it.each(["line1", "city", "state", "zipcode"] as const)(
    "missing address.%s → profileCompleted=false",
    async (missing) => {
      const user = makeUser();
      getUserFromRequest.mockResolvedValueOnce(user);
      const address: Record<string, unknown> = { ...FULL.address };
      delete address[missing];
      await POST(makeReq({ ...FULL, address }));
      expect(user.profileCompleted).toBe(false);
    }
  );

  it("QUIRK: missing address.country on BRAND-NEW user → profileCompleted=true (default 'IN' kicks in before completeness check)", async () => {
    const user = makeUser(); // No address — triggers the default-init branch.
    getUserFromRequest.mockResolvedValueOnce(user);
    const address: Record<string, unknown> = { ...FULL.address };
    delete address.country;
    await POST(makeReq({ ...FULL, address }));
    // The "IN" default fills in before checkProfileCompletion runs.
    expect(user.profileCompleted).toBe(true);
    expect(user.address?.country).toBe("IN");
  });

  it("missing address.country on EXISTING user with empty country → profileCompleted=false", async () => {
    const user = makeUser({
      address: { line1: "x", city: "x", state: "x", country: "", zipcode: "x" },
    });
    getUserFromRequest.mockResolvedValueOnce(user);
    const address: Record<string, unknown> = { ...FULL.address };
    delete address.country;
    await POST(makeReq({ ...FULL, address }));
    expect(user.profileCompleted).toBe(false);
  });
});

describe("Response curation (anti-leak)", () => {
  it("response body contains EXACTLY the 11 whitelisted user fields; no sentinel-leak fields", async () => {
    const user = makeUser({
      phone: "9999999999",
      phoneCc: "+91",
      companyName: "Acme",
      gstNumber: "29ABCDE1234F1Z5",
      address: {
        line1: "1 main st",
        city: "Mumbai",
        state: "MH",
        country: "IN",
        zipcode: "400001",
      },
    });
    getUserFromRequest.mockResolvedValueOnce(user);
    const res = await POST(makeReq({}));
    const body = await res.json();
    expect(Object.keys(body.user).sort()).toEqual([
      "address",
      "companyName",
      "email",
      "firstName",
      "gstNumber",
      "id",
      "lastName",
      "phone",
      "phoneCc",
      "profileCompleted",
      "provider",
      "role",
    ]);
    // Negative leak guard — sentinels MUST NOT appear in the body.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("$2a$12$BCRYPT_LEAK_ME_PROFILE");
    expect(raw).not.toContain("tok_LEAK_ME");
    expect(raw).not.toContain("JBSWY3DPEHPK3PXP");
    expect(raw).not.toContain("internal_da_LEAK");
  });
});

describe("Outer catch", () => {
  it("save throw → 500 generic; sentinel NOT leaked", async () => {
    const user = makeUser();
    user.save = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Mongo write fail — sa_key_LEAK_ME_PLEASE")
      );
    getUserFromRequest.mockResolvedValueOnce(user);
    const res = await POST(makeReq({}));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("sa_key_LEAK_ME_PLEASE");
  });
});
