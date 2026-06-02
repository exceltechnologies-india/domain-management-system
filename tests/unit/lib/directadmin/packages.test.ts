/**
 * Tests for `@/lib/directadmin/packages` (rescan-4 slice 7et).
 * DA hosting-package CRUD. The fns wrap an axios call inside the
 * shared `executeRequest` queue — we mock executeRequest to a thin
 * pass-through so we can assert the inner request shape directly.
 * Pins:
 *  - listPackages GETs CMD_API_PACKAGES_USER + parses URL-encoded
 *    response; **handles 3 response shapes** for the package list
 *    (`list[]` / `list` / `packages` — DA's wire returns whichever
 *    based on version)
 *  - listPackages HTML-login-page guard: response.data starts with `<`
 *    → throws (don't try to parse a login page as data)
 *  - listPackages DA in-band error (`error=1` or {error:'1'}) →
 *    throws DirectAdminError with parseDAError'd message
 *  - **Array.isArray normalisation**: single-string response wrapped
 *    into [string]; falsy entries filtered out
 *  - getPackageDetails normalises the package name via
 *    normalizePackageName (case-insensitive match against
 *    KNOWN_PACKAGES — `'standard'` → `'Standard'`)
 *  - createPackage validates package name first (throws on bad chars)
 *    + builds payload with sensible defaults (quota:1000, bandwidth:10000,
 *    mysql:5, domainptr:5, ftp:5 + cgi/php/spam ON)
 *  - createPackage options spread AFTER defaults — caller can override
 *    any default by supplying that key
 *  - **createPackage wraps unknown errors in `Failed to create hosting
 *    package: {message}`** for caller-facing display, but re-throws
 *    DirectAdminError untouched (typed-error preserved)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const executeRequestMock = vi.hoisted(() =>
  vi.fn(async (fn: () => Promise<unknown>) => fn())
);
const normalizePackageNameMock = vi.hoisted(() =>
  vi.fn((name: string) => name)
);
const validatePackageNameMock = vi.hoisted(() => vi.fn());
const parseDAErrorMock = vi.hoisted(() =>
  vi.fn((data: unknown) => {
    if (typeof data === "object" && data && "error" in data) {
      return (data as { text?: string }).text || "DA error";
    }
    if (typeof data === "string") return "parsed-string-error";
    return undefined;
  })
);
// Source parses URL-encoded strings into object maps. In tests we
// pre-provide the object form directly and let this mock pass through.
const parseResponseDataMock = vi.hoisted(() =>
  vi.fn((data: unknown) => data)
);
const DirectAdminErrorClass = vi.hoisted(
  () =>
    class extends Error {
      context?: string;
      status?: number;
      response?: unknown;
      constructor(
        message: string,
        context?: string,
        status?: number,
        response?: unknown
      ) {
        super(message);
        this.name = "DirectAdminError";
        this.context = context;
        this.status = status;
        this.response = response;
      }
    }
);

vi.mock("@/lib/directadmin/client", () => ({
  ADMIN_USER: "admin",
  API_KEY: "test-key",
  DA_URL: "https://da.test:2222",
  DEFAULT_TIMEOUT_MS: 8000,
  DirectAdminError: DirectAdminErrorClass,
  executeRequest: executeRequestMock,
  getAuth: () => ({ username: "admin", password: "test-key" }),
  normalizePackageName: normalizePackageNameMock,
  parseDAError: parseDAErrorMock,
  parseResponseData: parseResponseDataMock,
  validatePackageName: validatePackageNameMock,
}));

vi.mock("@/lib/directadmin/types", () => ({
  unwrapDAError: (err: unknown) => ({
    data: undefined,
    status: undefined,
    code: undefined,
    message: err instanceof Error ? err.message : "Unknown",
  }),
}));

const axiosGetMock = vi.hoisted(() => vi.fn());
const axiosPostMock = vi.hoisted(() => vi.fn());
vi.mock("axios", () => ({
  default: { get: axiosGetMock, post: axiosPostMock },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  listPackages,
  getPackageDetails,
  createPackage,
} from "@/lib/directadmin/packages";

beforeEach(() => {
  axiosGetMock.mockReset();
  axiosPostMock.mockReset();
  executeRequestMock.mockClear();
  normalizePackageNameMock.mockReset();
  normalizePackageNameMock.mockImplementation((name: string) => name);
  validatePackageNameMock.mockReset();
  parseDAErrorMock.mockClear();
  parseResponseDataMock.mockClear();
  parseResponseDataMock.mockImplementation((data: unknown) => data);
});

describe("listPackages", () => {
  // DA returns URL-encoded strings; the error check uses
  // `data.startsWith('error=1')` so we must provide string inputs.
  // parseResponseData (mocked) then parses to the object form.
  it("GETs CMD_API_PACKAGES_USER with basic auth + 8s timeout", async () => {
    parseResponseDataMock.mockReturnValueOnce({
      "list[]": ["Standard", "Pro"],
    });
    axiosGetMock.mockResolvedValueOnce({
      data: "list[]=Standard&list[]=Pro",
      status: 200,
    });
    await listPackages();
    expect(axiosGetMock).toHaveBeenCalledWith(
      "https://da.test:2222/CMD_API_PACKAGES_USER",
      {
        auth: { username: "admin", password: "test-key" },
        timeout: 8000,
      }
    );
  });

  it("response shape 'list[]' (array) → returned as-is", async () => {
    parseResponseDataMock.mockReturnValueOnce({
      "list[]": ["Standard", "Pro"],
    });
    axiosGetMock.mockResolvedValueOnce({
      data: "list[]=Standard&list[]=Pro",
    });
    expect(await listPackages()).toEqual(["Standard", "Pro"]);
  });

  it("response shape 'list' (alternative key) → also recognised", async () => {
    parseResponseDataMock.mockReturnValueOnce({
      list: ["Basic", "Advanced"],
    });
    axiosGetMock.mockResolvedValueOnce({ data: "list=Basic" });
    expect(await listPackages()).toEqual(["Basic", "Advanced"]);
  });

  it("response shape 'packages' (third alternative) → recognised", async () => {
    parseResponseDataMock.mockReturnValueOnce({ packages: ["Enterprise"] });
    axiosGetMock.mockResolvedValueOnce({ data: "packages=Enterprise" });
    expect(await listPackages()).toEqual(["Enterprise"]);
  });

  it("single-string (non-array) wrapped into [string]", async () => {
    parseResponseDataMock.mockReturnValueOnce({ "list[]": "Standalone" });
    axiosGetMock.mockResolvedValueOnce({ data: "list[]=Standalone" });
    expect(await listPackages()).toEqual(["Standalone"]);
  });

  it("falsy entries (null/empty/false) filtered out", async () => {
    parseResponseDataMock.mockReturnValueOnce({
      "list[]": ["Standard", "", null, "Pro"],
    });
    axiosGetMock.mockResolvedValueOnce({
      data: "list[]=Standard&list[]=&list[]=Pro",
    });
    expect(await listPackages()).toEqual(["Standard", "Pro"]);
  });

  it("HTML-login-page guard: response starts with `<` → throws", async () => {
    axiosGetMock.mockResolvedValueOnce({
      data: "<html><body>Login</body></html>",
    });
    await expect(listPackages()).rejects.toThrow(/Login Page/);
  });

  it("DA in-band error (object {error:'1'}) → DirectAdminError", async () => {
    axiosGetMock.mockResolvedValueOnce({
      data: { error: "1", text: "Access denied" },
    });
    await expect(listPackages()).rejects.toBeInstanceOf(DirectAdminErrorClass);
  });

  it("DA in-band error (string 'error=1&...') → DirectAdminError", async () => {
    axiosGetMock.mockResolvedValueOnce({
      data: "error=1&text=Some+failure",
    });
    await expect(listPackages()).rejects.toBeInstanceOf(DirectAdminErrorClass);
  });
});

describe("getPackageDetails", () => {
  it("normalises the package name via normalizePackageName + passes that to RC", async () => {
    normalizePackageNameMock.mockReturnValueOnce("Standard");
    parseResponseDataMock.mockReturnValueOnce({ quota: "1000" });
    axiosGetMock.mockResolvedValueOnce({
      data: "quota=1000&bandwidth=10000",
    });
    await getPackageDetails("standard");
    expect(normalizePackageNameMock).toHaveBeenCalledWith("standard");
    expect(axiosGetMock).toHaveBeenCalledWith(
      "https://da.test:2222/CMD_API_PACKAGES_USER",
      expect.objectContaining({ params: { package: "Standard" } })
    );
  });

  it("happy path: returns parsed response data", async () => {
    parseResponseDataMock.mockReturnValueOnce({
      quota: "1000",
      bandwidth: "10000",
      mysql: "5",
    });
    axiosGetMock.mockResolvedValueOnce({
      data: "quota=1000&bandwidth=10000&mysql=5",
    });
    const result = await getPackageDetails("Standard");
    expect(result).toEqual({ quota: "1000", bandwidth: "10000", mysql: "5" });
  });

  it("HTML-login-page guard for details too", async () => {
    axiosGetMock.mockResolvedValueOnce({
      data: "<html><body>Login</body></html>",
    });
    await expect(getPackageDetails("Standard")).rejects.toThrow(/Login Page/);
  });

  it("DA error → DirectAdminError with 'GetPackageDetails' context", async () => {
    axiosGetMock.mockResolvedValueOnce({
      data: { error: "1", text: "Package not found" },
    });
    try {
      await getPackageDetails("Standard");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DirectAdminErrorClass);
      expect((e as { context?: string }).context).toBe("GetPackageDetails");
    }
  });
});

describe("createPackage", () => {
  it("validates package name FIRST (throws via validatePackageName) — sync, NOT wrapped", async () => {
    validatePackageNameMock.mockImplementationOnce(() => {
      throw new Error("Invalid package name");
    });
    // validatePackageName runs BEFORE executeRequest, so the throw
    // bypasses the .catch() wrapper — caller sees the raw message.
    await expect(createPackage("bad!name")).rejects.toThrow(
      "Invalid package name"
    );
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it("normalises package name + POSTs with sensible defaults (quota=1000 etc.)", async () => {
    normalizePackageNameMock.mockReturnValueOnce("Standard");
    // DA returns a URL-encoded string body even on success
    axiosPostMock.mockResolvedValueOnce({ data: "success=1" });
    await createPackage("standard");
    const [url, body] = axiosPostMock.mock.calls[0];
    expect(url).toBe("https://da.test:2222/CMD_API_MANAGE_USER_PACKAGES");
    const params = new URLSearchParams(body as string);
    expect(params.get("packagename")).toBe("Standard");
    expect(params.get("action")).toBe("create");
    expect(params.get("quota")).toBe("1000");
    expect(params.get("bandwidth")).toBe("10000");
    expect(params.get("mysql")).toBe("5");
    expect(params.get("domainptr")).toBe("5");
    expect(params.get("ftp")).toBe("5");
    expect(params.get("cgi")).toBe("ON");
    expect(params.get("php")).toBe("ON");
    expect(params.get("spam")).toBe("ON");
  });

  it("options spread AFTER defaults → caller can override any default", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: "success=1" });
    await createPackage("Pro", {
      quota: "5000",
      mysql: "20",
      bandwidth: "50000",
    });
    const body = axiosPostMock.mock.calls[0][1] as string;
    const params = new URLSearchParams(body);
    expect(params.get("quota")).toBe("5000");
    expect(params.get("mysql")).toBe("20");
    expect(params.get("bandwidth")).toBe("50000");
  });

  it("DA error → DirectAdminError preserved (not wrapped)", async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: { error: "1", text: "Package exists" },
    });
    await expect(createPackage("Standard")).rejects.toBeInstanceOf(
      DirectAdminErrorClass
    );
  });

  it("non-DA error → wrapped in 'Failed to create hosting package: {message}'", async () => {
    axiosPostMock.mockRejectedValueOnce(new Error("Network unreachable"));
    await expect(createPackage("Standard")).rejects.toThrow(
      "Failed to create hosting package: Network unreachable"
    );
  });
});
