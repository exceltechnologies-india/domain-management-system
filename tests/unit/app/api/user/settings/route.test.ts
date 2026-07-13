/**
 * Tests for `app/api/user/settings/route.ts` (rescan-4 slice 7g2).
 * User profile + password update endpoint. THE place users mutate
 * their own account state — security-sensitive defense-in-depth path.
 * Pins:
 *  - **GET auth gate**: no user → 401 UNAUTHORIZED (no DB sync, no
 *    RC call, no response)
 *  - **GET response data-minimization**: explicit 12-field whitelist
 *    projection (firstName, lastName, email, phone, phoneCc,
 *    whatsappNumber, address, city, state, country, zipCode, company,
 *    gstNumber) — NEVER leaks password / role / resetToken / TOTP
 *    secrets / etc
 *  - **GET defaults**: phoneCc → '+91', country → 'IN' (anti-empty-
 *    string foot-gun on profile-completion check downstream)
 *  - **GET RC sync best-effort**: customerId lookup AND details
 *    pull both wrapped in try/catch — errors don't block the response
 *  - **PUT auth gate**: no user → 401 UNAUTHORIZED
 *  - **PUT profile schema validation**: Schemas.profileUpdate.safeParse
 *    failure → 400 VALIDATION_ERROR (anti-mass-assignment: blocks
 *    payload from setting role/admin/isActive etc — only the
 *    whitelisted profile fields can pass)
 *  - **PUT profile field assignment**: each field only written when
 *    defined; nested address initialized when absent; profileCompleted
 *    recomputed from updated state
 *  - **PUT password strength check**: validatePasswordStrength fail →
 *    400 WEAK_PASSWORD with FIRST error
 *  - **PUT password: getUserWithPassword for hash** (model has
 *    select:false on password; the auth-loaded doc doesn't carry it
 *    — must explicitly re-fetch)
 *  - **PUT password gate** (anti-ATO): if user has existing password,
 *    currentPassword required (400 MISSING_PASSWORD); wrong current →
 *    401 INVALID_PASSWORD; same as current → 400 SAME_PASSWORD
 *  - **PUT password: NO currentPassword check for OAuth-only users**
 *    who have no password hash yet (provider login)
 *  - **PUT response data-minimization**: 5-field user projection
 *    (id, email, firstName, lastName, profileCompleted, role) —
 *    NEVER includes password / resetToken / TOTP / address
 *  - **PUT RC + Zoho + email side-effects all SWALLOWED** (best-
 *    effort — profile mutation must commit even if external sync
 *    fails); resellerClubSynced + zohoBooksSynced flags in response
 *  - **PUT password change email**: isFirstTime detection
 *    (!hadPasswordBefore AND provider !== 'credentials')
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const rcGetCustomerId = vi.hoisted(() => vi.fn());
const rcGetCustomerDetails = vi.hoisted(() => vi.fn());
const rcModifyCustomer = vi.hoisted(() => vi.fn());
const rcModifyContact = vi.hoisted(() => vi.fn());
const rcCreateCustomer = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub", () => ({
  ResellerClubAPI: {
    getCustomerId: rcGetCustomerId,
    getCustomerDetails: rcGetCustomerDetails,
    modifyCustomer: rcModifyCustomer,
    modifyContact: rcModifyContact,
    createCustomer: rcCreateCustomer,
  },
}));

const profileUpdateSafeParse = vi.hoisted(() => vi.fn());
const validatePasswordStrength = vi.hoisted(() => vi.fn());
vi.mock("@/lib/validation", () => ({
  Schemas: {
    profileUpdate: { safeParse: profileUpdateSafeParse },
  },
  InputValidator: { validatePasswordStrength },
}));

const getUserWithPassword = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserWithPassword }));

const secureJsonResponse = vi.hoisted(() =>
  vi.fn((data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  )
);
const secureErrorResponse = vi.hoisted(() =>
  vi.fn(
    (message: string, status: number, code: string, _details?: unknown) =>
      new Response(JSON.stringify({ error: message, code }), {
        status,
        headers: { "Content-Type": "application/json" },
      })
  )
);
vi.mock("@/lib/api-response-wrapper", () => ({
  secureJsonResponse,
  secureErrorResponse,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const zohoGetContactByEmail = vi.hoisted(() => vi.fn());
const zohoUpdateContactDetails = vi.hoisted(() => vi.fn());
const zohoCreateContact = vi.hoisted(() => vi.fn());
const zohoGetInstance = vi.hoisted(() =>
  vi.fn(() => ({
    getContactByEmail: zohoGetContactByEmail,
    updateContactDetails: zohoUpdateContactDetails,
    createContact: zohoCreateContact,
  }))
);
vi.mock("@/lib/zohobooks", () => ({
  ZohoBooksService: { getInstance: zohoGetInstance },
}));

const sendPasswordChangeNotificationEmail = vi.hoisted(() => vi.fn());
const sendProfileUpdateEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: {
    sendPasswordChangeNotificationEmail,
    sendProfileUpdateEmail,
  },
}));

vi.unmock("next/server");
const { NextRequest } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({
  NextRequest,
  NextResponse: {
    json: (data: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(data), init),
  },
}));

import { GET, PUT } from "@/app/api/user/settings/route";

// ── helpers ──────────────────────────────────────────────────────────
function makeReq(method: "GET" | "PUT", body?: unknown) {
  return new NextRequest("https://example.com/api/user/settings", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function makeUser(overrides: Partial<any> = {}) {
  return {
    _id: "U1",
    email: "u@x.com",
    firstName: "First",
    lastName: "Last",
    phone: "9876543210",
    phoneCc: "+91",
    // Onboarded users have a WhatsApp number on file (now required on profile
    // save). Tests that specifically exercise the "missing WhatsApp" gate
    // override this to "".
    whatsappNumber: "9998887776",
    address: {
      line1: "1 St",
      city: "City",
      state: "State",
      country: "IN",
      zipcode: "400001",
    },
    companyName: "",
    gstNumber: "",
    resellerClubCustomerId: 100,
    resellerClubContactId: 200,
    role: "user",
    provider: "credentials",
    profileCompleted: true,
    save: vi.fn().mockResolvedValue(undefined),
    comparePassword: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  getUserFromRequest.mockReset();
  connectDB.mockReset().mockResolvedValue(undefined);
  rcGetCustomerId.mockReset().mockResolvedValue({ status: "success" });
  rcGetCustomerDetails
    .mockReset()
    .mockResolvedValue({ status: "success", data: {} });
  rcModifyCustomer.mockReset().mockResolvedValue({ status: "success" });
  rcModifyContact.mockReset().mockResolvedValue({ status: "success" });
  rcCreateCustomer
    .mockReset()
    .mockResolvedValue({ status: "success", data: 999 });
  profileUpdateSafeParse.mockReset().mockReturnValue({
    success: true,
    data: {},
  });
  validatePasswordStrength
    .mockReset()
    .mockReturnValue({ isValid: true, errors: [] });
  getUserWithPassword.mockReset();
  zohoGetContactByEmail.mockReset().mockResolvedValue(null);
  zohoUpdateContactDetails.mockReset().mockResolvedValue(true);
  zohoCreateContact.mockReset().mockResolvedValue({ contact_id: "C1" });
  sendPasswordChangeNotificationEmail
    .mockReset()
    .mockResolvedValue(undefined);
  sendProfileUpdateEmail.mockReset().mockResolvedValue(undefined);
  secureJsonResponse.mockClear();
  secureErrorResponse.mockClear();
});

// ─── GET: Auth gate ────────────────────────────────────────────────
describe("GET — auth gate FIRST", () => {
  it("no user → 401 UNAUTHORIZED (no RC call)", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(401);
    expect(rcGetCustomerId).not.toHaveBeenCalled();
    expect(rcGetCustomerDetails).not.toHaveBeenCalled();
  });
});

// ─── GET: RC sync ──────────────────────────────────────────────────
describe("GET — ResellerClub sync (best-effort side effect)", () => {
  it("RC ID missing → lookup + save when found", async () => {
    const user = makeUser({ resellerClubCustomerId: undefined });
    getUserFromRequest.mockResolvedValueOnce(user);
    rcGetCustomerId.mockResolvedValueOnce({
      status: "success",
      customerId: 555,
    });

    await GET(makeReq("GET"));

    expect(rcGetCustomerId).toHaveBeenCalledWith("u@x.com");
    expect(user.resellerClubCustomerId).toBe(555);
    expect(user.save).toHaveBeenCalled();
  });

  it("RC lookup failure SWALLOWED — response still issued", async () => {
    const user = makeUser({ resellerClubCustomerId: undefined });
    getUserFromRequest.mockResolvedValueOnce(user);
    rcGetCustomerId.mockRejectedValueOnce(new Error("RC down"));

    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(200);
  });

  it("RC details only fetched when customerId exists", async () => {
    const user = makeUser({ resellerClubCustomerId: undefined });
    getUserFromRequest.mockResolvedValueOnce(user);
    rcGetCustomerId.mockResolvedValueOnce({ status: "success" }); // no customerId

    await GET(makeReq("GET"));
    expect(rcGetCustomerDetails).not.toHaveBeenCalled();
  });

  it("RC details: fields backfill ONLY when local user value empty", async () => {
    const user = makeUser({
      firstName: "Existing",
      lastName: "",
      companyName: "",
    });
    getUserFromRequest.mockResolvedValueOnce(user);
    rcGetCustomerDetails.mockResolvedValueOnce({
      status: "success",
      data: {
        name: "Other Name",
        company: "RC Company",
      },
    });

    await GET(makeReq("GET"));
    // Existing firstName preserved
    expect(user.firstName).toBe("Existing");
    // Empty lastName + companyName backfilled
    expect(user.lastName).toBe("Name");
    expect(user.companyName).toBe("RC Company");
  });
});

// ─── GET: Response data-minimization ───────────────────────────────
describe("GET — response data-minimization", () => {
  it("returns 13-field profile projection (NO password / role / resetToken / TOTP)", async () => {
    const user = makeUser();
    getUserFromRequest.mockResolvedValueOnce(user);

    await GET(makeReq("GET"));

    const data = secureJsonResponse.mock.calls[0][0] as any;
    expect(data.profile).toBeDefined();
    expect(data.profile).not.toHaveProperty("password");
    expect(data.profile).not.toHaveProperty("role");
    expect(data.profile).not.toHaveProperty("resetToken");
    expect(data.profile).not.toHaveProperty("totpSecret");
    expect(data.profile).not.toHaveProperty("totpEnabled");
    expect(data.profile).not.toHaveProperty("_id");
  });

  it("explicit 14-key whitelist", async () => {
    getUserFromRequest.mockResolvedValueOnce(makeUser());
    await GET(makeReq("GET"));
    const data = secureJsonResponse.mock.calls[0][0] as any;
    expect(Object.keys(data.profile).sort()).toEqual(
      [
        "address",
        "city",
        "company",
        "country",
        "email",
        "firstName",
        "gstNumber",
        "lastName",
        "phone",
        "phoneCc",
        "state",
        "whatsappNumber",
        "whatsappOptOut",
        "zipCode",
      ].sort()
    );
  });

  it("default values: phoneCc='+91', country='IN' when local empty", async () => {
    const user = makeUser({ phoneCc: "", address: {} });
    getUserFromRequest.mockResolvedValueOnce(user);
    await GET(makeReq("GET"));
    const data = secureJsonResponse.mock.calls[0][0] as any;
    expect(data.profile.phoneCc).toBe("+91");
    expect(data.profile.country).toBe("IN");
  });
});

// ─── PUT: Auth gate ────────────────────────────────────────────────
describe("PUT — auth gate FIRST", () => {
  it("no user → 401 UNAUTHORIZED", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await PUT(makeReq("PUT", { profile: {} }));
    expect(res.status).toBe(401);
    expect(profileUpdateSafeParse).not.toHaveBeenCalled();
  });
});

// ─── PUT: Schema validation (anti-mass-assignment) ─────────────────
describe("PUT — profile schema validation (anti-mass-assignment)", () => {
  it("safeParse failure → 400 VALIDATION_ERROR", async () => {
    const user = makeUser();
    getUserFromRequest.mockResolvedValueOnce(user);
    profileUpdateSafeParse.mockReturnValueOnce({
      success: false,
      error: { format: () => ({ firstName: { _errors: ["bad"] } }) },
    });

    const res = await PUT(makeReq("PUT", { profile: { role: "admin" } }));
    expect(res.status).toBe(400);
    expect(user.save).not.toHaveBeenCalled();
  });

  it("safeParse success → ONLY parsed.data fields written to user (mass-assignment shield)", async () => {
    const user = makeUser({ role: "user" });
    getUserFromRequest.mockResolvedValueOnce(user);
    profileUpdateSafeParse.mockReturnValueOnce({
      success: true,
      data: { firstName: "Updated" },
      // even if body had role:'admin', parsed.data only has firstName
    });

    await PUT(
      makeReq("PUT", { profile: { firstName: "Updated", role: "admin" } })
    );

    expect(user.firstName).toBe("Updated");
    expect(user.role).toBe("user"); // role unchanged — mass-assignment-proof
  });
});

// ─── PUT: Profile field assignment ─────────────────────────────────
describe("PUT — profile field assignment", () => {
  it("each defined field updated; absent fields preserved", async () => {
    const user = makeUser({
      firstName: "Old",
      lastName: "Old",
      companyName: "OldCo",
    });
    getUserFromRequest.mockResolvedValueOnce(user);
    profileUpdateSafeParse.mockReturnValueOnce({
      success: true,
      data: { firstName: "New" }, // only firstName provided
    });

    await PUT(makeReq("PUT", { profile: { firstName: "New" } }));

    expect(user.firstName).toBe("New");
    expect(user.lastName).toBe("Old"); // unchanged
    expect(user.companyName).toBe("OldCo"); // unchanged
  });

  it("nested address init when missing", async () => {
    const user = makeUser({ address: undefined });
    getUserFromRequest.mockResolvedValueOnce(user);
    profileUpdateSafeParse.mockReturnValueOnce({
      success: true,
      data: { address: { line1: "New Addr" } },
    });

    await PUT(makeReq("PUT", { profile: { address: { line1: "New Addr" } } }));
    expect(user.address.line1).toBe("New Addr");
  });

  it("profileCompleted recomputed after update", async () => {
    const user = makeUser({ phone: "", phoneCc: "", profileCompleted: true });
    getUserFromRequest.mockResolvedValueOnce(user);
    profileUpdateSafeParse.mockReturnValueOnce({
      success: true,
      data: { firstName: "X" },
    });

    await PUT(makeReq("PUT", { profile: { firstName: "X" } }));

    // Empty phone/phoneCc → checkProfileCompletion returns false
    expect(user.profileCompleted).toBe(false);
  });

  it("**WhatsApp-only profile → phone auto-filled from WhatsApp number**", async () => {
    const user = makeUser({ phone: "", whatsappNumber: "" });
    getUserFromRequest.mockResolvedValueOnce(user);
    profileUpdateSafeParse.mockReturnValueOnce({
      success: true,
      data: { whatsappNumber: "9876543210" }, // WhatsApp provided, no phone
    });

    await PUT(makeReq("PUT", { profile: { whatsappNumber: "9876543210" } }));

    expect(user.whatsappNumber).toBe("9876543210");
    // Blank phone gets mirrored from WhatsApp so the profile has a phone.
    expect(user.phone).toBe("9876543210");
  });

  it("existing phone is NOT overwritten by a different WhatsApp number", async () => {
    const user = makeUser({ phone: "1112223334", whatsappNumber: "" });
    getUserFromRequest.mockResolvedValueOnce(user);
    profileUpdateSafeParse.mockReturnValueOnce({
      success: true,
      data: { whatsappNumber: "9876543210" },
    });

    await PUT(makeReq("PUT", { profile: { whatsappNumber: "9876543210" } }));

    expect(user.whatsappNumber).toBe("9876543210");
    expect(user.phone).toBe("1112223334"); // preserved — user wants two distinct numbers
  });

  it("WhatsApp number is REQUIRED — no stored + none submitted → 400 WHATSAPP_REQUIRED, no save", async () => {
    const user = makeUser({ whatsappNumber: "" });
    getUserFromRequest.mockResolvedValueOnce(user);
    profileUpdateSafeParse.mockReturnValueOnce({
      success: true,
      data: { firstName: "New" }, // no whatsappNumber
    });

    const res = await PUT(makeReq("PUT", { profile: { firstName: "New" } }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("WHATSAPP_REQUIRED");
    expect(user.save).not.toHaveBeenCalled();
  });

  it("WhatsApp already on file → partial profile save (no whatsapp field) still allowed", async () => {
    const user = makeUser({ whatsappNumber: "9998887776" });
    getUserFromRequest.mockResolvedValueOnce(user);
    profileUpdateSafeParse.mockReturnValueOnce({
      success: true,
      data: { firstName: "New" },
    });

    const res = await PUT(makeReq("PUT", { profile: { firstName: "New" } }));

    expect(res.status).toBe(200);
    expect(user.firstName).toBe("New");
  });

  it("notification email pinpoints the exact changed field labels", async () => {
    const user = makeUser({ firstName: "First", phone: "9876543210" });
    getUserFromRequest.mockResolvedValueOnce(user);
    profileUpdateSafeParse.mockReturnValueOnce({
      success: true,
      data: { firstName: "New", phone: "1230000000" },
    });

    await PUT(makeReq("PUT", { profile: { firstName: "New", phone: "1230000000" } }));

    expect(sendProfileUpdateEmail).toHaveBeenCalledTimes(1);
    const [, , changed] = sendProfileUpdateEmail.mock.calls[0];
    expect(changed).toEqual(
      expect.arrayContaining(["First name", "Phone number"])
    );
    // Untouched fields must NOT appear.
    expect(changed).not.toContain("Company name");
    expect(changed).not.toContain("WhatsApp number");
  });

  it("no-op save (submitted values equal current) → NO notification email", async () => {
    const user = makeUser({ firstName: "First", lastName: "Last" });
    getUserFromRequest.mockResolvedValueOnce(user);
    profileUpdateSafeParse.mockReturnValueOnce({
      success: true,
      data: { firstName: "First", lastName: "Last" }, // identical to stored
    });

    const res = await PUT(makeReq("PUT", { profile: { firstName: "First", lastName: "Last" } }));

    expect(res.status).toBe(200);
    expect(sendProfileUpdateEmail).not.toHaveBeenCalled();
  });
});

// ─── PUT: Password update gates ────────────────────────────────────
describe("PUT — password update gates", () => {
  function setupWithPassword(hasExistingPassword = true) {
    const user = makeUser({ provider: "credentials" });
    getUserFromRequest.mockResolvedValueOnce(user);
    getUserWithPassword.mockResolvedValueOnce({
      password: hasExistingPassword ? "$2b$existing" : "",
      comparePassword: vi.fn().mockResolvedValue(true),
    });
    return user;
  }

  it("weak password → 400 WEAK_PASSWORD with FIRST error", async () => {
    getUserFromRequest.mockResolvedValueOnce(makeUser());
    validatePasswordStrength.mockReturnValueOnce({
      isValid: false,
      errors: ["Too short", "Missing uppercase"],
    });

    const res = await PUT(
      makeReq("PUT", { password: { currentPassword: "X", newPassword: "x" } })
    );
    expect(res.status).toBe(400);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "Too short", // first error
      400,
      "WEAK_PASSWORD"
    );
  });

  it("user not found via getUserWithPassword → 404 USER_NOT_FOUND", async () => {
    getUserFromRequest.mockResolvedValueOnce(makeUser());
    getUserWithPassword.mockResolvedValueOnce(null);

    const res = await PUT(
      makeReq("PUT", {
        password: { currentPassword: "X", newPassword: "NewP@ss1" },
      })
    );
    expect(res.status).toBe(404);
  });

  it("user has password but no currentPassword → 400 MISSING_PASSWORD", async () => {
    setupWithPassword(true);
    const res = await PUT(
      makeReq("PUT", { password: { newPassword: "NewP@ss1" } })
    );
    expect(res.status).toBe(400);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "Current password required",
      400,
      "MISSING_PASSWORD"
    );
  });

  it("currentPassword wrong → 401 INVALID_PASSWORD", async () => {
    const user = makeUser();
    getUserFromRequest.mockResolvedValueOnce(user);
    getUserWithPassword.mockResolvedValueOnce({
      password: "$2b$existing",
      comparePassword: vi.fn().mockResolvedValueOnce(false),
    });

    const res = await PUT(
      makeReq("PUT", {
        password: { currentPassword: "WRONG", newPassword: "NewP@ss1" },
      })
    );
    expect(res.status).toBe(401);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "Incorrect current password",
      401,
      "INVALID_PASSWORD"
    );
  });

  it("new password same as current → 400 SAME_PASSWORD", async () => {
    const user = makeUser();
    getUserFromRequest.mockResolvedValueOnce(user);
    getUserWithPassword.mockResolvedValueOnce({
      password: "$2b$existing",
      comparePassword: vi
        .fn()
        .mockResolvedValueOnce(true) // current matches
        .mockResolvedValueOnce(true), // new ALSO matches
    });

    const res = await PUT(
      makeReq("PUT", {
        password: { currentPassword: "Same", newPassword: "Same" },
      })
    );
    expect(res.status).toBe(400);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "New password must be different",
      400,
      "SAME_PASSWORD"
    );
  });

  it("**OAuth-only user (no password) skips currentPassword check**", async () => {
    const user = makeUser({ provider: "google" });
    getUserFromRequest.mockResolvedValueOnce(user);
    getUserWithPassword.mockResolvedValueOnce({
      password: "", // no existing password
      comparePassword: vi.fn(),
    });

    const res = await PUT(
      makeReq("PUT", {
        password: { newPassword: "NewP@ss1" }, // no currentPassword
      })
    );
    // Should NOT return MISSING_PASSWORD — should proceed to save
    expect(res.status).toBe(200);
    expect((user as any).password).toBe("NewP@ss1");
  });
});

// ─── PUT: Response data-minimization ───────────────────────────────
describe("PUT — response data-minimization", () => {
  it("user projection: 6-field whitelist (id, email, firstName, lastName, profileCompleted, role)", async () => {
    const user = makeUser();
    getUserFromRequest.mockResolvedValueOnce(user);
    profileUpdateSafeParse.mockReturnValueOnce({
      success: true,
      data: { firstName: "X" },
    });

    await PUT(makeReq("PUT", { profile: { firstName: "X" } }));

    const data = secureJsonResponse.mock.calls[0][0] as any;
    expect(data.user).toBeDefined();
    expect(Object.keys(data.user).sort()).toEqual(
      [
        "email",
        "firstName",
        "id",
        "lastName",
        "profileCompleted",
        "role",
      ].sort()
    );
    expect(data.user).not.toHaveProperty("password");
    expect(data.user).not.toHaveProperty("resetToken");
    expect(data.user).not.toHaveProperty("totpSecret");
    expect(data.user).not.toHaveProperty("address");
  });

  it("response includes resellerClubSynced + zohoBooksSynced flags", async () => {
    const user = makeUser();
    getUserFromRequest.mockResolvedValueOnce(user);
    profileUpdateSafeParse.mockReturnValueOnce({
      success: true,
      data: { firstName: "X" },
    });

    await PUT(makeReq("PUT", { profile: { firstName: "X" } }));
    const data = secureJsonResponse.mock.calls[0][0] as any;
    expect(data).toHaveProperty("resellerClubSynced");
    expect(data).toHaveProperty("zohoBooksSynced");
  });
});

// ─── PUT: Side-effect resilience ───────────────────────────────────
describe("PUT — RC + Zoho + email side-effects all SWALLOWED", () => {
  it("RC modifyCustomer throw does NOT abort response", async () => {
    const user = makeUser();
    getUserFromRequest.mockResolvedValueOnce(user);
    profileUpdateSafeParse.mockReturnValueOnce({
      success: true,
      data: { firstName: "X" },
    });
    rcModifyCustomer.mockRejectedValueOnce(new Error("RC down"));

    const res = await PUT(makeReq("PUT", { profile: { firstName: "X" } }));
    expect(res.status).toBe(200);
  });

  it("Zoho sync failure does NOT abort response", async () => {
    const user = makeUser();
    getUserFromRequest.mockResolvedValueOnce(user);
    profileUpdateSafeParse.mockReturnValueOnce({
      success: true,
      data: { firstName: "X" },
    });
    zohoGetContactByEmail.mockRejectedValueOnce(new Error("Zoho down"));

    const res = await PUT(makeReq("PUT", { profile: { firstName: "X" } }));
    expect(res.status).toBe(200);
  });

  it("profile email notification swallowed", async () => {
    const user = makeUser();
    getUserFromRequest.mockResolvedValueOnce(user);
    profileUpdateSafeParse.mockReturnValueOnce({
      success: true,
      data: { firstName: "X" },
    });
    sendProfileUpdateEmail.mockRejectedValueOnce(new Error("SMTP down"));

    const res = await PUT(makeReq("PUT", { profile: { firstName: "X" } }));
    expect(res.status).toBe(200);
  });
});

// ─── PUT: First-time password detection ────────────────────────────
describe("PUT — password change isFirstTime detection", () => {
  it("OAuth user (no prev password, provider!=='credentials') → isFirstTime=true", async () => {
    const user = makeUser({ provider: "google" });
    getUserFromRequest.mockResolvedValueOnce(user);
    getUserWithPassword.mockResolvedValueOnce({
      password: "",
      comparePassword: vi.fn(),
    });

    await PUT(
      makeReq("PUT", { password: { newPassword: "NewP@ss1" } })
    );

    expect(sendPasswordChangeNotificationEmail).toHaveBeenCalledWith(
      "u@x.com",
      expect.any(String),
      true, // isFirstTime
      "google"
    );
  });

  it("credentials user changing password → isFirstTime=false", async () => {
    const user = makeUser({ provider: "credentials" });
    getUserFromRequest.mockResolvedValueOnce(user);
    getUserWithPassword.mockResolvedValueOnce({
      password: "$2b$existing",
      comparePassword: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
    });

    await PUT(
      makeReq("PUT", {
        password: { currentPassword: "OldP@ss1", newPassword: "NewP@ss1" },
      })
    );

    expect(sendPasswordChangeNotificationEmail).toHaveBeenCalledWith(
      "u@x.com",
      expect.any(String),
      false, // NOT first time
      "credentials"
    );
  });
});

// ─── Outer catch ───────────────────────────────────────────────────
describe("Outer catch — 500 fallback", () => {
  it("connectDB throw → 500", async () => {
    connectDB.mockRejectedValueOnce(new Error("DB down"));
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(500);
  });

  it("PUT: user.save throw → 500 SERVER_ERROR", async () => {
    const user = makeUser({
      save: vi.fn().mockRejectedValueOnce(new Error("DB write down")),
    });
    getUserFromRequest.mockResolvedValueOnce(user);
    profileUpdateSafeParse.mockReturnValueOnce({
      success: true,
      data: { firstName: "X" },
    });

    const res = await PUT(makeReq("PUT", { profile: { firstName: "X" } }));
    expect(res.status).toBe(500);
  });
});
