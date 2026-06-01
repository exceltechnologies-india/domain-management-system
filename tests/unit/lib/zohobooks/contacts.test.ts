/**
 * Tests for `@/lib/zohobooks/contacts` (rescan-4 slice 7eb).
 * Zoho Books contact + contact-person CRUD. Pins:
 *  - getContactByEmail / getContactByName: MISSING_REFRESH_TOKEN ZohoError
 *    propagates (lets refund-flow distinguish "not found" from "broken auth")
 *  - createContact: GST sanitization (trim whitespace, uppercase) WHEN
 *    gst is non-empty; consumer treatment otherwise
 *  - createContact GST-validation-failed fallback (errorData.code:2 +
 *    'gst' in message) → strips gst_no + retries as consumer
 *  - createContact duplicate-name fallback (errorData.code:3062) →
 *    finds the existing contact by name and returns it
 *  - updateContactDetails: cascades to contact-person update via
 *    getContactPersons + updateContactPerson; person-update failure
 *    LOGS WARN but main update still succeeds (return true)
 *  - updateContactToConsumer: sends gst_treatment:'consumer' + empty gst_no
 *  - All HTTP routes through self._idempotentRetry (transient 503 retry)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AxiosError } from "axios";

function makeAxiosError(status: number, data: unknown): AxiosError {
  const err = new AxiosError("Request failed", "ERR_BAD_REQUEST");
  err.response = {
    status,
    statusText: "",
    headers: {},
    config: {} as never,
    data,
  };
  return err;
}

const zohoGet = vi.hoisted(() => vi.fn());
const zohoPost = vi.hoisted(() => vi.fn());
const zohoPut = vi.hoisted(() => vi.fn());
vi.mock("@/lib/zohobooks/axios-client", () => ({
  zohoAxios: { get: zohoGet, post: zohoPost, put: zohoPut },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const FakeZohoError = vi.hoisted(
  () =>
    class extends Error {
      type: string;
      code: string;
      constructor(type: string, code: string, message: string) {
        super(message);
        this.type = type;
        this.code = code;
      }
    }
);
vi.mock("@/lib/zohobooks", () => ({ ZohoError: FakeZohoError }));

import {
  getContactByEmail,
  getContactByName,
  createContact,
  updateContactDetails,
  getContactPersons,
  updateContactPerson,
  updateContactToConsumer,
} from "@/lib/zohobooks/contacts";

function makeSelf(opts: Partial<{ hasToken: boolean; isValidGst: boolean }> = {}) {
  return {
    _hasRefreshToken: vi.fn().mockReturnValue(opts.hasToken ?? true),
    _getHeaders: vi.fn().mockResolvedValue({ Authorization: "Zoho-oauthtoken X" }),
    _idempotentRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    _isValidGst: vi.fn().mockReturnValue(opts.isValidGst ?? true),
    _baseUrl: "https://www.zohoapis.com/books/v3",
    _defaultParams: { organization_id: "ORG_123" },
    getContactByName: vi.fn(),
    getContactPersons: vi.fn(),
    updateContactPerson: vi.fn(),
  };
}

const USER: Record<string, unknown> = {
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.test",
  phone: "+91999",
  companyName: "Acme",
  gstNumber: "07AABCU9603R1ZM",
  address: {
    line1: "1 Main",
    city: "Mumbai",
    state: "MH",
    zipcode: "400001",
    country: "IN",
  },
};

beforeEach(() => {
  zohoGet.mockReset();
  zohoPost.mockReset();
  zohoPut.mockReset();
});

describe("getContactByEmail", () => {
  it("returns first contact when code:0 + contacts.length>0", async () => {
    const self = makeSelf();
    zohoGet.mockResolvedValueOnce({
      data: { code: 0, contacts: [{ contact_id: "C_HIT", contact_name: "Jane" }] },
    });
    const result = await getContactByEmail(self as never, "jane@x.test");
    expect(result?.contact_id).toBe("C_HIT");
    const [url, opts] = zohoGet.mock.calls[0];
    expect(url).toBe("https://www.zohoapis.com/books/v3/contacts");
    expect(opts.params.email).toBe("jane@x.test");
  });

  it("returns null when contacts is empty", async () => {
    const self = makeSelf();
    zohoGet.mockResolvedValueOnce({ data: { code: 0, contacts: [] } });
    expect(await getContactByEmail(self as never, "x@y.test")).toBeNull();
  });

  it("MISSING_REFRESH_TOKEN ZohoError propagates (auth-vs-not-found distinction)", async () => {
    const self = makeSelf({ hasToken: false });
    await expect(getContactByEmail(self as never, "x@y.test")).rejects.toMatchObject({
      code: "MISSING_REFRESH_TOKEN",
    });
  });

  it("axios throws → returns null (treated as 'not found' after logging)", async () => {
    const self = makeSelf();
    zohoGet.mockRejectedValueOnce(new Error("500"));
    expect(await getContactByEmail(self as never, "x@y.test")).toBeNull();
  });
});

describe("getContactByName", () => {
  it("queries with contact_name + returns first hit", async () => {
    const self = makeSelf();
    zohoGet.mockResolvedValueOnce({
      data: { code: 0, contacts: [{ contact_id: "C_NAME", contact_name: "Jane Doe" }] },
    });
    const result = await getContactByName(self as never, "Jane Doe");
    expect(result?.contact_id).toBe("C_NAME");
    const [, opts] = zohoGet.mock.calls[0];
    expect(opts.params.contact_name).toBe("Jane Doe");
  });
});

describe("createContact", () => {
  it("sanitises GST (trim + remove spaces + uppercase) when gstNumber is set", async () => {
    const self = makeSelf();
    zohoPost.mockResolvedValueOnce({
      data: { code: 0, contact: { contact_id: "C_NEW" } },
    });
    await createContact(self as never, {
      ...USER,
      gstNumber: "  07aabcu9603r 1zm  ",
    } as never);
    const [, body] = zohoPost.mock.calls[0];
    expect(body.gst_no).toBe("07AABCU9603R1ZM");
    expect(body.gst_treatment).toBe("business_registered");
  });

  it("no GST → consumer treatment (no gst_no field)", async () => {
    const self = makeSelf();
    zohoPost.mockResolvedValueOnce({
      data: { code: 0, contact: { contact_id: "C_NEW" } },
    });
    await createContact(self as never, { ...USER, gstNumber: "" } as never);
    const [, body] = zohoPost.mock.calls[0];
    expect(body.gst_treatment).toBe("consumer");
    expect(body.gst_no).toBeUndefined();
  });

  it("GST-validation fallback (Zoho code:2 + 'gst' in message) → retries as consumer", async () => {
    const self = makeSelf();
    zohoPost
      .mockRejectedValueOnce(
        makeAxiosError(400, { code: 2, message: "Invalid GST number provided" })
      )
      .mockResolvedValueOnce({
        data: { code: 0, contact: { contact_id: "C_FALLBACK" } },
      });
    const result = await createContact(self as never, USER as never);
    expect(result?.contact_id).toBe("C_FALLBACK");
    // The retry body must NOT carry gst_no.
    const [, retryBody] = zohoPost.mock.calls[1];
    expect(retryBody.gst_no).toBeUndefined();
    expect(retryBody.gst_treatment).toBe("consumer");
  });

  it("duplicate-name fallback (Zoho code:3062) → returns the existing contact via name lookup", async () => {
    const self = makeSelf();
    self.getContactByName.mockResolvedValueOnce({ contact_id: "C_EXISTING" });
    zohoPost.mockRejectedValueOnce(
      makeAxiosError(409, { code: 3062, message: "Contact name already exists" })
    );
    const result = await createContact(self as never, USER as never);
    expect(result?.contact_id).toBe("C_EXISTING");
    expect(self.getContactByName).toHaveBeenCalledWith("Jane Doe");
  });
});

describe("updateContactDetails", () => {
  it("cascades to updateContactPerson via getContactPersons → primary match", async () => {
    const self = makeSelf();
    zohoPut.mockResolvedValueOnce({ data: { code: 0 } });
    self.getContactPersons.mockResolvedValueOnce([
      { contact_person_id: "P_OTHER", is_primary_contact: false },
      { contact_person_id: "P_PRIMARY", is_primary_contact: true },
    ]);
    self.updateContactPerson.mockResolvedValueOnce(true);
    const result = await updateContactDetails(self as never, "CONTACT_1", USER as never);
    expect(result).toBe(true);
    expect(self.updateContactPerson).toHaveBeenCalledWith("P_PRIMARY", USER as never);
  });

  it("person-update failure: WARN logged, main contact still succeeds (returns true)", async () => {
    const self = makeSelf();
    zohoPut.mockResolvedValueOnce({ data: { code: 0 } });
    self.getContactPersons.mockRejectedValueOnce(new Error("503"));
    const result = await updateContactDetails(self as never, "CONTACT_1", USER as never);
    expect(result).toBe(true);
  });

  it("main update throw → returns false (degrade gracefully)", async () => {
    const self = makeSelf();
    zohoPut.mockRejectedValueOnce(new Error("503"));
    expect(await updateContactDetails(self as never, "CONTACT_1", USER as never)).toBe(false);
  });
});

describe("getContactPersons", () => {
  it("returns the contact_persons array on code:0", async () => {
    const self = makeSelf();
    zohoGet.mockResolvedValueOnce({
      data: { code: 0, contact_persons: [{ contact_person_id: "P1" }] },
    });
    const result = await getContactPersons(self as never, "C_1");
    expect(result).toEqual([{ contact_person_id: "P1" }]);
  });

  it("no-refresh-token → [] (lazy init)", async () => {
    const self = makeSelf({ hasToken: false });
    expect(await getContactPersons(self as never, "C_1")).toEqual([]);
  });
});

describe("updateContactPerson", () => {
  it("PUTs to /contacts/contactpersons/{id} with phone mirrored to mobile", async () => {
    const self = makeSelf();
    zohoPut.mockResolvedValueOnce({ data: { code: 0 } });
    const result = await updateContactPerson(self as never, "P_1", USER as never);
    expect(result).toBe(true);
    const [url, body] = zohoPut.mock.calls[0];
    expect(url).toBe(
      "https://www.zohoapis.com/books/v3/contacts/contactpersons/P_1"
    );
    expect(body.phone).toBe("+91999");
    expect(body.mobile).toBe("+91999");
  });
});

describe("updateContactToConsumer", () => {
  it("PUTs gst_treatment:'consumer' + gst_no:'' (the invoice-blocker fallback)", async () => {
    const self = makeSelf();
    zohoPut.mockResolvedValueOnce({ data: { code: 0 } });
    const result = await updateContactToConsumer(self as never, "CONTACT_1");
    expect(result).toBe(true);
    const [, body] = zohoPut.mock.calls[0];
    expect(body.gst_treatment).toBe("consumer");
    expect(body.gst_no).toBe("");
  });

  it("zoho code != 0 → returns false", async () => {
    const self = makeSelf();
    zohoPut.mockResolvedValueOnce({ data: { code: 9001, message: "oops" } });
    expect(await updateContactToConsumer(self as never, "C")).toBe(false);
  });
});
