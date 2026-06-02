/**
 * Tests for `@/lib/resellerclub/customers` simple wire helpers
 * (rescan-4 slice 7eq). Skips getOrCreateCustomerAndContact (orchestration
 * — integration-test material). Pins:
 *  - **getCustomerId** distinguishes 3 result states: 'success' (customer
 *    found, returns parsed numeric customerId), 'error' (customer details
 *    fetched but no customerid in body), 'not_found' (RC throws — the
 *    expected "customer doesn't exist" path)
 *  - getCustomerId parseInt: RC's customerid is a string ("12345" → 12345)
 *  - createCustomer POSTs `/api/customers/signup.json` with the full
 *    13-param body (kebab-case keys for RC's API + `lang-pref` default
 *    'en' + `company` defaults to `name` + `reseller-id` from env)
 *  - createCustomer error: extracts `error.response.data.message` when
 *    AxiosError; falls back to error.message
 *  - createContact POSTs `/api/contacts/add.json` with type:'Contact'/
 *    'CaDomain'/'IrtContact' enum
 *  - modifyContact builds params CONDITIONALLY (only sets each kebab-case
 *    key when the corresponding input field is supplied — so a partial
 *    update doesn't overwrite untouched RC fields)
 *  - getCustomerDetails / getCustomerDomains wrap RC response into
 *    `{status:'success', data}` / `{status:'error', message}` shape
 *  - getCustomerDomains: 500-record pagination + page-no=1
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AxiosError } from "axios";

const apiGet = vi.hoisted(() => vi.fn());
const apiPost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub/client", () => ({
  api: { get: apiGet, post: apiPost },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  getCustomerId,
  createCustomer,
  modifyContact,
  createContact,
  getCustomerDetails,
  getCustomerDomains,
} from "@/lib/resellerclub/customers";

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  vi.stubEnv("RESELLERCLUB_RESELLER_ID", "RC_RID_42");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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

describe("getCustomerId — 3-way state surface", () => {
  it("RC returns customerid → status:'success' with parsed numeric customerId", async () => {
    apiGet.mockResolvedValueOnce({ data: { customerid: "12345" }, status: 200 });
    const result = await getCustomerId("u@x.test");
    expect(result).toEqual({ status: "success", customerId: 12345 });
    expect(apiGet).toHaveBeenCalledWith("/api/customers/details.json", {
      params: { username: "u@x.test" },
    });
  });

  it("RC returns 200 but no customerid in body → status:'error' (data present but missing key)", async () => {
    apiGet.mockResolvedValueOnce({ data: {}, status: 200 });
    const result = await getCustomerId("u@x.test");
    expect(result.status).toBe("error");
    expect(result.customerId).toBeUndefined();
  });

  it("RC throw (the 'customer does not exist' path) → status:'not_found'", async () => {
    apiGet.mockRejectedValueOnce(makeAxiosError(404, { message: "Not found" }));
    const result = await getCustomerId("u@x.test");
    expect(result.status).toBe("not_found");
    expect(result.error).toMatch(/does not exist/i);
  });
});

describe("createCustomer", () => {
  it("POSTs /api/customers/signup.json with kebab-case keys + reseller-id from env", async () => {
    apiPost.mockResolvedValueOnce({ data: { customerid: "999" }, status: 200 });
    await createCustomer({
      username: "u@x.test",
      passwd: "p",
      name: "Alice",
      addressLine1: "1 Main",
      city: "Mumbai",
      state: "MH",
      country: "IN",
      zipcode: "400001",
      phoneCc: "91",
      phone: "9999999999",
    });
    const [url, body, opts] = apiPost.mock.calls[0];
    expect(url).toBe("/api/customers/signup.json");
    expect(body).toBeNull();
    expect(opts.params["address-line-1"]).toBe("1 Main");
    expect(opts.params["phone-cc"]).toBe("91");
    expect(opts.params["lang-pref"]).toBe("en");
    expect(opts.params["reseller-id"]).toBe("RC_RID_42");
    // company defaults to name when not supplied.
    expect(opts.params.company).toBe("Alice");
  });

  it("custom company + custom langPref pass through", async () => {
    apiPost.mockResolvedValueOnce({ data: {}, status: 200 });
    await createCustomer({
      username: "u@x.test",
      passwd: "p",
      name: "Alice",
      company: "Acme Co",
      langPref: "hi",
      addressLine1: "1 Main",
      city: "Mumbai",
      state: "MH",
      country: "IN",
      zipcode: "400001",
      phoneCc: "91",
      phone: "9",
    });
    expect(apiPost.mock.calls[0][2].params.company).toBe("Acme Co");
    expect(apiPost.mock.calls[0][2].params["lang-pref"]).toBe("hi");
  });

  it("RESELLERCLUB_RESELLER_ID unset → falls back to RESELLERCLUB_ID", async () => {
    vi.stubEnv("RESELLERCLUB_RESELLER_ID", "");
    vi.stubEnv("RESELLERCLUB_ID", "RC_BASE_ID");
    apiPost.mockResolvedValueOnce({ data: {}, status: 200 });
    await createCustomer({
      username: "u",
      passwd: "p",
      name: "x",
      addressLine1: "a",
      city: "c",
      state: "s",
      country: "IN",
      zipcode: "0",
      phoneCc: "91",
      phone: "9",
    });
    expect(apiPost.mock.calls[0][2].params["reseller-id"]).toBe("RC_BASE_ID");
  });

  it("AxiosError with data.message → returns that message as error", async () => {
    apiPost.mockRejectedValueOnce(
      makeAxiosError(400, { message: "Username already exists" })
    );
    const result = await createCustomer({
      username: "dup",
      passwd: "p",
      name: "x",
      addressLine1: "a",
      city: "c",
      state: "s",
      country: "IN",
      zipcode: "0",
      phoneCc: "91",
      phone: "9",
    });
    expect(result.status).toBe("error");
    expect(result.error).toBe("Username already exists");
  });

  it("non-Axios throw → 'Unknown error occurred' fallback", async () => {
    apiPost.mockRejectedValueOnce(new Error("network down"));
    const result = await createCustomer({
      username: "u",
      passwd: "p",
      name: "x",
      addressLine1: "a",
      city: "c",
      state: "s",
      country: "IN",
      zipcode: "0",
      phoneCc: "91",
      phone: "9",
    });
    expect(result.status).toBe("error");
    // Plain Error (non-Axios) → falls through to the literal sentinel.
    expect(result.error).toBe("Unknown error occurred");
  });
});

describe("createContact", () => {
  it("POSTs /api/contacts/add.json with type enum + kebab-case params", async () => {
    apiPost.mockResolvedValueOnce({ data: { contactid: "55" }, status: 200 });
    await createContact({
      customerId: 7,
      name: "Alice",
      email: "alice@x.test",
      addressLine1: "1 Main",
      city: "Mumbai",
      state: "MH",
      country: "IN",
      zipcode: "400001",
      phoneCc: "91",
      phone: "9",
      type: "Contact",
    });
    const [url, , opts] = apiPost.mock.calls[0];
    expect(url).toBe("/api/contacts/add.json");
    expect(opts.params["customer-id"]).toBe(7);
    expect(opts.params.type).toBe("Contact");
    expect(opts.params["address-line-1"]).toBe("1 Main");
    expect(opts.params["phone-cc"]).toBe("91");
  });

  it("type:'CaDomain' (Canadian) and 'IrtContact' both pass through verbatim", async () => {
    apiPost.mockResolvedValue({ data: {}, status: 200 });
    await createContact({
      customerId: 1,
      name: "x",
      email: "a@x",
      addressLine1: "a",
      city: "c",
      state: "s",
      country: "CA",
      zipcode: "0",
      phoneCc: "1",
      phone: "9",
      type: "CaDomain",
    });
    expect(apiPost.mock.calls[0][2].params.type).toBe("CaDomain");

    await createContact({
      customerId: 1,
      name: "x",
      email: "a@x",
      addressLine1: "a",
      city: "c",
      state: "s",
      country: "IE",
      zipcode: "0",
      phoneCc: "1",
      phone: "9",
      type: "IrtContact",
    });
    expect(apiPost.mock.calls[1][2].params.type).toBe("IrtContact");
  });
});

describe("modifyContact — conditional param construction (partial update)", () => {
  it("only contactId supplied → params has ONLY contact-id (untouched fields not overwritten)", async () => {
    apiPost.mockResolvedValueOnce({ data: {}, status: 200 });
    await modifyContact({ contactId: 42 });
    const [, , opts] = apiPost.mock.calls[0];
    expect(opts.params).toEqual({ "contact-id": 42 });
  });

  it("name + city supplied → only those two extra params + contact-id", async () => {
    apiPost.mockResolvedValueOnce({ data: {}, status: 200 });
    await modifyContact({ contactId: 42, name: "New Name", city: "New City" });
    const [, , opts] = apiPost.mock.calls[0];
    expect(opts.params).toEqual({
      "contact-id": 42,
      name: "New Name",
      city: "New City",
    });
    expect(opts.params["address-line-1"]).toBeUndefined();
    expect(opts.params["phone-cc"]).toBeUndefined();
  });

  it("RC error message extracted from AxiosError response data", async () => {
    apiPost.mockRejectedValueOnce(
      makeAxiosError(400, { message: "Invalid contact-id" })
    );
    const result = await modifyContact({ contactId: 42, name: "x" });
    expect(result.status).toBe("error");
    expect(result.message).toBe("Invalid contact-id");
  });
});

describe("getCustomerDetails", () => {
  it("happy path: wraps response into {status:'success', data}", async () => {
    apiGet.mockResolvedValueOnce({
      data: { customerid: "42", username: "u@x.test" },
    });
    const result = await getCustomerDetails("u@x.test");
    expect(result.status).toBe("success");
    expect(result.data).toEqual({ customerid: "42", username: "u@x.test" });
  });

  it("error → wraps into 'Failed to get customer details' sentinel", async () => {
    apiGet.mockRejectedValueOnce(new Error("503"));
    const result = await getCustomerDetails("u@x.test");
    expect(result).toEqual({
      status: "error",
      message: "Failed to get customer details",
    });
  });
});

describe("getCustomerDomains", () => {
  it("paginated request: no-of-records=500, page-no=1, customer-id", async () => {
    apiGet.mockResolvedValueOnce({ data: { "example.com": {} } });
    await getCustomerDomains(7);
    const [url, opts] = apiGet.mock.calls[0];
    expect(url).toBe("/api/domains/search.json");
    expect(opts.params).toEqual({
      "customer-id": 7,
      "no-of-records": 500,
      "page-no": 1,
    });
  });

  it("error → 'Failed to fetch customer domains' sentinel", async () => {
    apiGet.mockRejectedValueOnce(new Error("503"));
    const result = await getCustomerDomains(7);
    expect(result).toEqual({
      status: "error",
      message: "Failed to fetch customer domains",
    });
  });
});
