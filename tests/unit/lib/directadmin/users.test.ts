/**
 * Tests for `@/lib/directadmin/users` (rescan-4 slice 7ev).
 * DA user lifecycle: SSO + create/read/modify/suspend/delete +
 * domain-existence + bulk-usage. Pins:
 *  - **getOneTimeLoginUrl auth form switching**: admin user uses
 *    plain getAuth(); non-admin uses `${ADMIN_USER}|{username}` form
 *    (DA Login-As syntax — required so DA generates a session in the
 *    TARGET user's context, not the key-owner's)
 *  - SSO payload includes 5 `select_denyN` entries (block password
 *    change / login-key / 2FA / change-info from the SSO session) +
 *    1-hour expiry_timestamp + max_uses:1 + clear_key:yes (cannot
 *    re-use a generated SSO link)
 *  - SSO response handling: raw URL starting with `http` returned
 *    as-is; JSON envelope `{result: 'http...'}` unwrapped (newer DA);
 *    unexpected shape → typed error
 *  - createUser validates username + normalises/validates package +
 *    generates a random temp password (passwd === passwd2); default
 *    ip = DA_SERVER_IP; **friendly error for 'already exists'** —
 *    rewrites to 'User or domain already exists on the server.'
 *  - getUserConfig + getUserUsage GETs distinct DA endpoints with
 *    `user` param + admin auth
 *  - **getUserDomains 3-way response handling**: list[]/list → arrays;
 *    keys-as-domain-names fallback (DA sometimes returns `{x.com:
 *    "stats", y.com: "stats"}` — filters out `error/text/details`
 *    keys + requires `.` in the key as a heuristic)
 *  - changePackage/suspendUser/unsuspendUser/deleteUser send their
 *    distinct action params to the right DA endpoint
 *  - **domainExists fail-safe defaults to false** on any error (lets
 *    purchase proceed; DA will reject at create-user time if domain
 *    truly exists — safer than blocking a valid order)
 *  - listUsers + getAllUserUsage parse the URL-encoded response shape
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const executeRequestMock = vi.hoisted(() =>
  vi.fn(async (fn: () => Promise<unknown>) => fn())
);
const validateUsernameMock = vi.hoisted(() => vi.fn());
const validatePackageNameMock = vi.hoisted(() => vi.fn());
const normalizePackageNameMock = vi.hoisted(() =>
  vi.fn((name: string) => name)
);
const parseDAErrorMock = vi.hoisted(() =>
  vi.fn((data: unknown) => {
    if (typeof data === "object" && data && "text" in data) {
      return (data as { text?: string }).text || "DA error";
    }
    if (typeof data === "string") return "parsed-string-error";
    // For undefined / non-string non-object: return undefined so the
    // source's `parseDAError(u.data) || u.message` falls through.
    return undefined;
  })
);
const parseResponseDataMock = vi.hoisted(() =>
  vi.fn((data: unknown) => data)
);
const DirectAdminErrorClass = vi.hoisted(
  () =>
    class extends Error {
      context?: string;
      status?: number;
      constructor(
        message: string,
        context?: string,
        status?: number
      ) {
        super(message);
        this.name = "DirectAdminError";
        this.context = context;
        this.status = status;
      }
    }
);

vi.mock("@/lib/directadmin/client", () => ({
  ADMIN_USER: "admin",
  API_KEY: "test-key",
  DA_URL: "https://da.test:2222",
  DA_SERVER_IP: "136.115.64.54",
  DEFAULT_TIMEOUT_MS: 8000,
  DirectAdminError: DirectAdminErrorClass,
  executeRequest: executeRequestMock,
  getAuth: () => ({ username: "admin", password: "test-key" }),
  normalizePackageName: normalizePackageNameMock,
  parseDAError: parseDAErrorMock,
  parseResponseData: parseResponseDataMock,
  validateUsername: validateUsernameMock,
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
  getOneTimeLoginUrl,
  createUser,
  getUserConfig,
  getUserUsage,
  getUserDomains,
  changePackage,
  suspendUser,
  unsuspendUser,
  deleteUser,
  domainExists,
  listUsers,
  getAllUserUsage,
} from "@/lib/directadmin/users";

beforeEach(() => {
  axiosGetMock.mockReset();
  axiosPostMock.mockReset();
  validateUsernameMock.mockReset();
  validatePackageNameMock.mockReset();
  normalizePackageNameMock.mockReset();
  normalizePackageNameMock.mockImplementation((n: string) => n);
  parseResponseDataMock.mockReset();
  parseResponseDataMock.mockImplementation((d: unknown) => d);
});

describe("getOneTimeLoginUrl — SSO link generation", () => {
  it("non-admin user: auth uses ADMIN_USER|username form (DA Login-As)", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: "https://da.test:2222/onetime?key=X" });
    await getOneTimeLoginUrl("alice");
    const [, , opts] = axiosPostMock.mock.calls[0];
    expect(opts.auth).toEqual({
      username: "admin|alice",
      password: "test-key",
    });
  });

  it("admin user: uses plain getAuth() (no |username suffix — admin context)", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: "https://da.test:2222/onetime?key=X" });
    await getOneTimeLoginUrl("admin");
    const [, , opts] = axiosPostMock.mock.calls[0];
    expect(opts.auth.username).toBe("admin");
    expect(opts.auth.username).not.toContain("|");
  });

  it("payload includes 5 select_deny entries + max_uses:1 + clear_key:yes + 1hr expiry", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: "https://da.test:2222/x" });
    await getOneTimeLoginUrl("alice");
    const [, body] = axiosPostMock.mock.calls[0];
    const params = new URLSearchParams(body as string);
    expect(params.get("action")).toBe("create");
    expect(params.get("type")).toBe("one_time_url");
    expect(params.get("user")).toBe("alice");
    expect(params.get("max_uses")).toBe("1");
    expect(params.get("clear_key")).toBe("yes");
    expect(params.get("notify")).toBe("no");
    expect(params.get("select_deny0")).toBe("CMD_USER_PASSWD");
    expect(params.get("select_deny1")).toBe("CMD_LOGIN_KEYS");
    expect(params.get("select_deny4")).toBe("CMD_TWO_FACTOR_AUTH");
    // expiry is ~1 hour from now (epoch seconds).
    const expiry = parseInt(params.get("expiry_timestamp") || "0", 10);
    const now = Math.floor(Date.now() / 1000);
    expect(expiry).toBeGreaterThanOrEqual(now + 3500);
    expect(expiry).toBeLessThanOrEqual(now + 3700);
  });

  it("custom redirectUrl forwarded", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: "https://da.test:2222/x" });
    await getOneTimeLoginUrl("alice", "CMD_FILE_MANAGER");
    const body = axiosPostMock.mock.calls[0][1] as string;
    expect(new URLSearchParams(body).get("redirect-url")).toBe("CMD_FILE_MANAGER");
  });

  it("response: raw URL starting with `http` returned as-is", async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: "https://da.test:2222/onetime?key=ABC",
    });
    expect(await getOneTimeLoginUrl("alice")).toBe(
      "https://da.test:2222/onetime?key=ABC"
    );
  });

  it("response: JSON envelope `{result: 'http...'}` unwrapped (newer DA)", async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: { result: "https://da.test:2222/onetime?key=XYZ" },
    });
    expect(await getOneTimeLoginUrl("alice")).toBe(
      "https://da.test:2222/onetime?key=XYZ"
    );
  });

  it("unexpected response shape → wrapped 'Failed to generate DirectAdmin SSO link'", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: { something: "else" } });
    await expect(getOneTimeLoginUrl("alice")).rejects.toThrow(
      /Failed to generate DirectAdmin SSO link/
    );
  });
});

describe("createUser", () => {
  it("payload: action=create + add=Submit + temp password equals passwd2 + ip default = DA_SERVER_IP", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: "success=1" });
    await createUser("alice", "a@x.test", "x.com", "Standard");
    const [, body] = axiosPostMock.mock.calls[0];
    const params = new URLSearchParams(body as string);
    expect(params.get("action")).toBe("create");
    expect(params.get("add")).toBe("Submit");
    expect(params.get("username")).toBe("alice");
    expect(params.get("email")).toBe("a@x.test");
    expect(params.get("domain")).toBe("x.com");
    expect(params.get("package")).toBe("Standard");
    expect(params.get("ip")).toBe("136.115.64.54");
    // passwd and passwd2 should match (DA requires both).
    expect(params.get("passwd")).toBe(params.get("passwd2"));
    expect(params.get("passwd")?.length).toBeGreaterThan(0);
  });

  it("custom IP overrides DA_SERVER_IP default", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: "success=1" });
    await createUser("alice", "a@x.test", "x.com", "Standard", "10.0.0.1");
    expect(
      new URLSearchParams(axiosPostMock.mock.calls[0][1] as string).get("ip")
    ).toBe("10.0.0.1");
  });

  it("validates username + normalizes/validates package BEFORE the POST", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: "success=1" });
    await createUser("alice", "a@x.test", "x.com", "standard");
    expect(validateUsernameMock).toHaveBeenCalledWith("alice");
    expect(normalizePackageNameMock).toHaveBeenCalledWith("standard");
    expect(validatePackageNameMock).toHaveBeenCalled();
  });

  it("friendly error rewrite: non-DA error containing 'already exists' → 'User or domain already exists on the server.'", async () => {
    // The friendly rewrite triggers on the .catch() path AFTER
    // DirectAdminError check — typed DA errors are preserved as-is.
    // So we need a NON-DirectAdminError whose message contains "already exists".
    axiosPostMock.mockRejectedValueOnce(new Error("Username already exists"));
    await expect(
      createUser("alice", "a@x.test", "x.com", "Standard")
    ).rejects.toThrow("User or domain already exists on the server.");
  });

  it("DirectAdminError preserved (not wrapped)", async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: { error: "1", text: "Package not found" },
    });
    await expect(
      createUser("alice", "a@x.test", "x.com", "Standard")
    ).rejects.toBeInstanceOf(DirectAdminErrorClass);
  });

  it("non-DA error → wrapped 'Failed to create DirectAdmin user: {message}'", async () => {
    axiosPostMock.mockRejectedValueOnce(new Error("network down"));
    await expect(
      createUser("alice", "a@x.test", "x.com", "Standard")
    ).rejects.toThrow(/Failed to create DirectAdmin user/);
  });
});

describe("getUserConfig + getUserUsage — read endpoints", () => {
  it("getUserConfig GETs CMD_API_SHOW_USER_CONFIG with user param + admin auth", async () => {
    parseResponseDataMock.mockReturnValueOnce({ username: "alice", package: "Standard" });
    axiosGetMock.mockResolvedValueOnce({ data: "username=alice&package=Standard" });
    await getUserConfig("alice");
    expect(axiosGetMock).toHaveBeenCalledWith(
      "https://da.test:2222/CMD_API_SHOW_USER_CONFIG",
      expect.objectContaining({
        params: { user: "alice" },
        auth: { username: "admin", password: "test-key" },
      })
    );
  });

  it("getUserUsage GETs CMD_API_SHOW_USER_USAGE", async () => {
    parseResponseDataMock.mockReturnValueOnce({ quota: "500" });
    axiosGetMock.mockResolvedValueOnce({ data: "quota=500" });
    await getUserUsage("alice");
    expect(axiosGetMock).toHaveBeenCalledWith(
      "https://da.test:2222/CMD_API_SHOW_USER_USAGE",
      expect.any(Object)
    );
  });

  it("getUserConfig error → wrapped 'Failed to fetch user config: {message}'", async () => {
    axiosGetMock.mockRejectedValueOnce(new Error("503"));
    await expect(getUserConfig("alice")).rejects.toThrow(/Failed to fetch user config/);
  });

  it("getUserUsage error → wrapped 'Failed to fetch user usage: {message}'", async () => {
    axiosGetMock.mockRejectedValueOnce(new Error("503"));
    await expect(getUserUsage("alice")).rejects.toThrow(/Failed to fetch user usage/);
  });
});

describe("getUserDomains — 3-way response handling", () => {
  it("list[] array → returned filtered", async () => {
    parseResponseDataMock.mockReturnValueOnce({
      "list[]": ["x.com", "y.com"],
    });
    axiosGetMock.mockResolvedValueOnce({
      data: "list[]=x.com&list[]=y.com",
    });
    expect(await getUserDomains("alice")).toEqual(["x.com", "y.com"]);
  });

  it("list (alternative key, array) → returned", async () => {
    parseResponseDataMock.mockReturnValueOnce({ list: ["x.com"] });
    axiosGetMock.mockResolvedValueOnce({ data: "list=x.com" });
    expect(await getUserDomains("alice")).toEqual(["x.com"]);
  });

  it("keys-as-domains fallback: response has domain.com as keys with stats values", async () => {
    parseResponseDataMock.mockReturnValueOnce({
      "x.com": "stats=...",
      "y.com": "stats=...",
      error: "0", // these meta-keys are filtered out
      text: "ok",
    });
    axiosGetMock.mockResolvedValueOnce({
      data: "x.com=stats&y.com=stats",
    });
    expect(await getUserDomains("alice")).toEqual(["x.com", "y.com"]);
  });

  it("error → wraps in 'Failed to fetch user domains: {message}' (throws, not silent [])", async () => {
    axiosGetMock.mockRejectedValueOnce(new Error("503"));
    await expect(getUserDomains("alice")).rejects.toThrow(
      /Failed to fetch user domains/
    );
  });
});

describe("changePackage / suspendUser / unsuspendUser / deleteUser", () => {
  it("changePackage POSTs CMD_API_MODIFY_USER with action=package + user + package", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: "success=1" });
    await changePackage("alice", "Pro");
    const [url, body] = axiosPostMock.mock.calls[0];
    expect(url).toBe("https://da.test:2222/CMD_API_MODIFY_USER");
    const params = new URLSearchParams(body as string);
    expect(params.get("action")).toBe("package");
    expect(params.get("user")).toBe("alice");
    expect(params.get("package")).toBe("Pro");
  });

  it("suspendUser POSTs CMD_API_SELECT_USERS with dosuspend=Suspend + reason", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: "success=1" });
    await suspendUser("alice", "Non-payment");
    const [url, body] = axiosPostMock.mock.calls[0];
    expect(url).toBe("https://da.test:2222/CMD_API_SELECT_USERS");
    const params = new URLSearchParams(body as string);
    expect(params.get("dosuspend")).toBe("Suspend");
    expect(params.get("select0")).toBe("alice");
    expect(params.get("reason")).toBe("Non-payment");
  });

  it("suspendUser default reason = 'Admin Action'", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: "success=1" });
    await suspendUser("alice");
    const params = new URLSearchParams(axiosPostMock.mock.calls[0][1] as string);
    expect(params.get("reason")).toBe("Admin Action");
  });

  it("unsuspendUser uses dounsuspend=Unsuspend (no reason field needed)", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: "success=1" });
    await unsuspendUser("alice");
    const params = new URLSearchParams(axiosPostMock.mock.calls[0][1] as string);
    expect(params.get("dounsuspend")).toBe("Unsuspend");
    expect(params.get("select0")).toBe("alice");
  });

  it("deleteUser uses delete=Delete + confirmed=Confirm (DA's 2-step confirmation)", async () => {
    axiosPostMock.mockResolvedValueOnce({ data: "success=1" });
    await deleteUser("alice");
    const params = new URLSearchParams(axiosPostMock.mock.calls[0][1] as string);
    expect(params.get("delete")).toBe("Delete");
    expect(params.get("confirmed")).toBe("Confirm");
    expect(params.get("select0")).toBe("alice");
  });
});

describe("domainExists — fail-safe defaults to false", () => {
  it("empty domain → false (no HTTP call)", async () => {
    expect(await domainExists("")).toBe(false);
    expect(axiosGetMock).not.toHaveBeenCalled();
  });

  it("domain found in response keys → true", async () => {
    parseResponseDataMock.mockReturnValueOnce({ "x.com": "owner=alice" });
    axiosGetMock.mockResolvedValueOnce({ data: "x.com=alice" });
    expect(await domainExists("x.com")).toBe(true);
  });

  it("domain found in response values → also true", async () => {
    parseResponseDataMock.mockReturnValueOnce({ someKey: "x.com" });
    axiosGetMock.mockResolvedValueOnce({ data: "someKey=x.com" });
    expect(await domainExists("x.com")).toBe(true);
  });

  it("error=1 response → false (DA reports domain not found)", async () => {
    axiosGetMock.mockResolvedValueOnce({
      data: "error=1&text=Domain+not+found",
    });
    expect(await domainExists("missing.com")).toBe(false);
  });

  it("HTTP throw → false (fail-safe: let purchase proceed)", async () => {
    axiosGetMock.mockRejectedValueOnce(new Error("503"));
    expect(await domainExists("x.com")).toBe(false);
  });
});

describe("listUsers + getAllUserUsage", () => {
  it("listUsers GETs CMD_API_SHOW_USERS + returns the list[] array", async () => {
    parseResponseDataMock.mockReturnValueOnce({
      "list[]": ["alice", "bob"],
    });
    axiosGetMock.mockResolvedValueOnce({
      data: "list[]=alice&list[]=bob",
    });
    expect(await listUsers()).toEqual(["alice", "bob"]);
  });

  it("listUsers filters falsy entries", async () => {
    parseResponseDataMock.mockReturnValueOnce({
      "list[]": ["alice", "", null, "bob"],
    });
    axiosGetMock.mockResolvedValueOnce({ data: "list[]=alice&list[]=&list[]=bob" });
    expect(await listUsers()).toEqual(["alice", "bob"]);
  });

  it("getAllUserUsage GETs CMD_API_SHOW_ALL_USER_USAGE + returns the parsed object", async () => {
    parseResponseDataMock.mockReturnValueOnce({
      alice: "quota=500&used=50",
      bob: "quota=1000&used=100",
    });
    axiosGetMock.mockResolvedValueOnce({
      data: "alice=quota%3D500&bob=quota%3D1000",
    });
    const result = await getAllUserUsage();
    expect(result.alice).toBe("quota=500&used=50");
    expect(result.bob).toBe("quota=1000&used=100");
  });
});
