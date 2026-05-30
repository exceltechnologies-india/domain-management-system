/**
 * Tests for `@/lib/directadmin/server` (rescan-4 slice 7dr).
 * Three server-level DA operations — getServerInfo, listResellers,
 * getLicenseInfo. All three follow the same pattern: axios.get with
 * basic auth → error=1 detection → parseResponseData. Pins the URL
 * path, auth header, timeout, and DA in-band-error handling.
 *
 * Mocks `@/lib/directadmin/client` so we don't have to env-stub for
 * the inner client constants.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const axiosGetMock = vi.hoisted(() => vi.fn());
vi.mock("axios", () => ({
  default: { get: axiosGetMock },
}));

const executeRequestMock = vi.hoisted(() =>
  vi.fn(async (fn: () => Promise<unknown>) => fn())
);
const getAuthMock = vi.hoisted(() => vi.fn(() => ({ username: "admin", password: "secret" })));
const parseDAErrorMock = vi.hoisted(() => vi.fn((d: unknown) => `parsed:${String(d)}`));
const parseResponseDataMock = vi.hoisted(() => vi.fn((d: unknown) => d));

const FakeDirectAdminError = vi.hoisted(
  () =>
    class DirectAdminError extends Error {
      status?: number;
      data?: unknown;
      op?: string;
      constructor(message: string, op?: string, status?: number, data?: unknown) {
        super(message);
        this.name = "DirectAdminError";
        this.op = op;
        this.status = status;
        this.data = data;
      }
    }
);

vi.mock("@/lib/directadmin/client", () => ({
  DA_URL: "https://da.example.test:2222",
  DEFAULT_TIMEOUT_MS: 30_000,
  DirectAdminError: FakeDirectAdminError,
  executeRequest: executeRequestMock,
  getAuth: getAuthMock,
  parseDAError: parseDAErrorMock,
  parseResponseData: parseResponseDataMock,
}));

import {
  getServerInfo,
  listResellers,
  getLicenseInfo,
} from "@/lib/directadmin/server";

beforeEach(() => {
  axiosGetMock.mockReset();
  executeRequestMock.mockClear();
  parseResponseDataMock.mockClear();
  parseDAErrorMock.mockClear();
  // Default: every call goes through executeRequest's pass-through impl.
  executeRequestMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
});

describe("getServerInfo", () => {
  it("GETs CMD_API_SYSTEM_INFO with basic auth + default timeout, returns parsed data", async () => {
    axiosGetMock.mockResolvedValueOnce({
      data: "key1=val1&key2=val2",
    });
    parseResponseDataMock.mockReturnValueOnce({ key1: "val1", key2: "val2" });
    const result = await getServerInfo();
    expect(axiosGetMock).toHaveBeenCalledWith(
      "https://da.example.test:2222/CMD_API_SYSTEM_INFO",
      {
        auth: { username: "admin", password: "secret" },
        timeout: 30_000,
      }
    );
    expect(result).toEqual({ key1: "val1", key2: "val2" });
    expect(executeRequestMock).toHaveBeenCalledWith(expect.any(Function), "GetServerInfo");
  });

  it("DA in-band error (error='1' object) → throws DirectAdminError", async () => {
    axiosGetMock.mockResolvedValueOnce({
      data: { error: "1", text: "auth failed" },
    });
    await expect(getServerInfo()).rejects.toThrow(/parsed:/);
    expect(parseDAErrorMock).toHaveBeenCalled();
  });

  it("DA in-band error (string body starting with 'error=1') → throws DirectAdminError", async () => {
    axiosGetMock.mockResolvedValueOnce({
      data: "error=1&text=auth%20failed",
    });
    await expect(getServerInfo()).rejects.toThrow(/parsed:/);
  });
});

describe("listResellers", () => {
  it("GETs CMD_API_SHOW_RESELLERS and unwraps the list[] / list field into an array", async () => {
    axiosGetMock.mockResolvedValueOnce({
      data: "list[]=admin&list[]=reseller1",
    });
    parseResponseDataMock.mockReturnValueOnce({
      "list[]": ["admin", "reseller1"],
    });
    const result = await listResellers();
    expect(result).toEqual(["admin", "reseller1"]);
    expect(axiosGetMock.mock.calls[0][0]).toBe(
      "https://da.example.test:2222/CMD_API_SHOW_RESELLERS"
    );
  });

  it("coerces a single-string `list` value into a 1-element array", async () => {
    axiosGetMock.mockResolvedValueOnce({ data: "list=admin" });
    parseResponseDataMock.mockReturnValueOnce({ list: "admin" });
    const result = await listResellers();
    expect(result).toEqual(["admin"]);
  });

  it("falsy entries are filtered out", async () => {
    axiosGetMock.mockResolvedValueOnce({ data: "list[]=ok&list[]=" });
    parseResponseDataMock.mockReturnValueOnce({
      "list[]": ["ok", "", null as unknown as string],
    });
    const result = await listResellers();
    expect(result).toEqual(["ok"]);
  });

  it("DA in-band error → throws DirectAdminError", async () => {
    axiosGetMock.mockResolvedValueOnce({
      data: "error=1&text=denied",
    });
    await expect(listResellers()).rejects.toThrow();
  });
});

describe("getLicenseInfo", () => {
  it("GETs CMD_API_LICENSE and returns parsed data", async () => {
    axiosGetMock.mockResolvedValueOnce({
      data: "users_used=15&users_max=100",
    });
    parseResponseDataMock.mockReturnValueOnce({
      users_used: "15",
      users_max: "100",
    });
    const result = await getLicenseInfo();
    expect(result).toEqual({ users_used: "15", users_max: "100" });
    expect(axiosGetMock.mock.calls[0][0]).toBe(
      "https://da.example.test:2222/CMD_API_LICENSE"
    );
  });

  it("DA in-band error → throws DirectAdminError", async () => {
    axiosGetMock.mockResolvedValueOnce({
      data: { error: "1", text: "no license" },
    });
    await expect(getLicenseInfo()).rejects.toThrow();
  });
});
