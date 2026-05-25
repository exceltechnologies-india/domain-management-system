/**
 * Unit tests for the zustand cart store (rescan-4 M14 slice 16).
 * Complements cart-validation.test.ts — that suite covers the pure
 * helpers; this one exercises the store-level behaviour around them:
 * the restricted-TLD gate at add time, the linked-hosting cascade on
 * domain removal, the getter math, and the syncWithServer happy paths.
 *
 * Mocks:
 *   - react-hot-toast: replaced by a spy bag so we can assert the
 *     correct error/info toasts fire on restricted TLDs and cascade.
 *   - global.fetch: stubbed per test to drive the server-sync branches
 *     deterministically (default = fail-soft 401 so the unconditional
 *     debounced saveToServer after every mutation doesn't surface
 *     errors in unrelated tests).
 *   - @/lib/logger: silenced.
 *
 * The store itself is a singleton — each test resets it via the
 * exposed setState to keep cases isolated.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { CartItem } from "@/lib/types";

// vi.mock is hoisted to the top of the file, so anything its factory
// references must also be hoisted. vi.hoisted() pulls the toastMock
// declaration up so the factory below can capture it.
const { toastMock } = vi.hoisted(() => {
  const m = Object.assign(vi.fn(), { error: vi.fn() });
  return { toastMock: m };
});

vi.mock("react-hot-toast", () => ({
  default: toastMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import after mocks so the store picks them up.
import { useCartStore } from "@/store/cartStore";

const baseDomain = (overrides: Partial<CartItem> = {}): CartItem => ({
  domainName: "example.com",
  price: 999,
  currency: "INR",
  registrationPeriod: 1,
  itemType: "domain",
  ...overrides,
});

const baseHosting = (overrides: Partial<CartItem> = {}): CartItem => ({
  domainName: "example.com",
  price: 1500,
  currency: "INR",
  registrationPeriod: 12,
  itemType: "hosting",
  billingCycle: "yearly",
  periodUnit: "months",
  ...overrides,
});

beforeEach(() => {
  // Reset store between tests — clear items, isLoading, isInitialized.
  useCartStore.setState({ items: [], isLoading: false, isInitialized: false });
  toastMock.mockClear();
  toastMock.error.mockClear();
  // Default fetch stub: every call resolves to a 401 (fail-soft for guests).
  // Tests that exercise the server-sync paths override this per-case.
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status: 401,
    json: async () => ({}),
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cartStore.addItem", () => {
  it("blocks restricted TLDs with an error toast and doesn't add to cart", () => {
    // .au is restricted in tld-policies.
    useCartStore.getState().addItem(baseDomain({ domainName: "example.au" }));
    expect(useCartStore.getState().items).toHaveLength(0);
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("example.au requires local presence"),
      expect.any(Object)
    );
  });

  it("adds a non-restricted domain and clamps period via the helper", () => {
    // .ai has min=2 — period 1 should snap to 2.
    useCartStore.getState().addItem(
      baseDomain({ domainName: "foo.ai", registrationPeriod: 1 })
    );
    const items = useCartStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].registrationPeriod).toBe(2);
  });

  it("dedups by (domainName, itemType) — re-adding same domain merges, doesn't duplicate", () => {
    useCartStore.getState().addItem(baseDomain({ price: 999 }));
    useCartStore.getState().addItem(baseDomain({ price: 1499, registrationPeriod: 3 }));
    const items = useCartStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].price).toBe(1499);
    expect(items[0].registrationPeriod).toBe(3);
  });

  it("same domain + different itemType stays separate (domain + hosting on same name)", () => {
    useCartStore.getState().addItem(baseDomain({ domainName: "shop.com" }));
    useCartStore.getState().addItem(baseHosting({ domainName: "shop.com" }));
    const items = useCartStore.getState().items;
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.itemType).sort()).toEqual(["domain", "hosting"]);
  });
});

describe("cartStore.removeItem", () => {
  it("removes a single domain item by name", () => {
    useCartStore.setState({
      items: [
        baseDomain({ domainName: "one.com" }),
        baseDomain({ domainName: "two.com" }),
      ],
    });
    useCartStore.getState().removeItem("one.com");
    const items = useCartStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].domainName).toBe("two.com");
  });

  it("cascade-drops the linked hosting item when its domain is removed", () => {
    useCartStore.setState({
      items: [
        baseDomain({ domainName: "linked.com" }),
        baseHosting({ domainName: "linked.com" }),
        baseDomain({ domainName: "other.com" }),
      ],
    });
    useCartStore.getState().removeItem("linked.com", "domain");
    const items = useCartStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].domainName).toBe("other.com");
    // Cascade fires an info toast.
    expect(toastMock).toHaveBeenCalledWith(
      expect.stringContaining("Hosting plan removed"),
      expect.any(Object)
    );
  });

  it("removing only the hosting item leaves the domain item in place", () => {
    useCartStore.setState({
      items: [
        baseDomain({ domainName: "paired.com" }),
        baseHosting({ domainName: "paired.com" }),
      ],
    });
    useCartStore.getState().removeItem("paired.com", "hosting");
    const items = useCartStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].itemType).toBe("domain");
  });

  it("clearCart empties items entirely", () => {
    useCartStore.setState({
      items: [baseDomain({ domainName: "a.com" }), baseHosting({ domainName: "b.com" })],
    });
    useCartStore.getState().clearCart();
    expect(useCartStore.getState().items).toEqual([]);
  });
});

describe("cartStore getters", () => {
  it("getSubtotalPrice multiplies price × registrationPeriod across items", () => {
    useCartStore.setState({
      items: [
        baseDomain({ price: 100, registrationPeriod: 2 }),  // 200
        baseDomain({ domainName: "x.com", price: 50, registrationPeriod: 3 }), // 150
        baseHosting({ domainName: "y.com", price: 200, registrationPeriod: 12 }), // 2400
      ],
    });
    expect(useCartStore.getState().getSubtotalPrice()).toBe(2750);
  });

  it("getTotalPrice rounds the subtotal to 2 decimal places", () => {
    useCartStore.setState({
      items: [baseDomain({ price: 33.333, registrationPeriod: 1 })],
    });
    expect(useCartStore.getState().getTotalPrice()).toBe(33.33);
  });

  it("getItemCount returns array length", () => {
    expect(useCartStore.getState().getItemCount()).toBe(0);
    useCartStore.setState({
      items: [baseDomain(), baseHosting({ domainName: "x.com" })],
    });
    expect(useCartStore.getState().getItemCount()).toBe(2);
  });

  it("hasDomainItems / hasHostingItems detect each kind", () => {
    expect(useCartStore.getState().hasDomainItems()).toBe(false);
    expect(useCartStore.getState().hasHostingItems()).toBe(false);

    useCartStore.setState({ items: [baseHosting({ domainName: "x.com" })] });
    expect(useCartStore.getState().hasDomainItems()).toBe(false);
    expect(useCartStore.getState().hasHostingItems()).toBe(true);

    useCartStore.setState({ items: [baseDomain()] });
    expect(useCartStore.getState().hasDomainItems()).toBe(true);
    expect(useCartStore.getState().hasHostingItems()).toBe(false);
  });

  it("hasDomainItems treats items with missing itemType as domain (backward compat)", () => {
    useCartStore.setState({
      items: [{ ...baseDomain(), itemType: undefined } as CartItem],
    });
    expect(useCartStore.getState().hasDomainItems()).toBe(true);
    expect(useCartStore.getState().hasHostingItems()).toBe(false);
  });
});

describe("cartStore.loadFromServer", () => {
  it("populates items from the server response and runs them through validation", async () => {
    // .ai needs min=2; server returns a .ai with period 1 → validated to 2.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        cart: [{ domainName: "x.ai", price: 999, currency: "INR", registrationPeriod: 1, itemType: "domain" }],
        dropped: [],
      }),
    }) as unknown as typeof fetch;

    await useCartStore.getState().loadFromServer();
    const items = useCartStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].registrationPeriod).toBe(2);
  });

  it("fires an error toast when the server reports dropped restricted domains", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        cart: [],
        dropped: ["example.au", "example.uk"],
      }),
    }) as unknown as typeof fetch;

    await useCartStore.getState().loadFromServer();
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Removed restricted domains"),
      expect.any(Object)
    );
  });

  it("on 401 (guest), is a no-op — items stay as they were", async () => {
    useCartStore.setState({
      items: [baseDomain({ domainName: "local.com" })],
    });
    // Default fetch stub (set in beforeEach) returns ok:false / status 401.
    await useCartStore.getState().loadFromServer();
    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().items[0].domainName).toBe("local.com");
  });
});

describe("cartStore.syncWithServer", () => {
  it("local-only / server-empty → pushes local cart to server, keeps local items", async () => {
    // 1st fetch (loadFromServer GET) → server returns empty cart
    // 2nd fetch (saveToServer POST)  → returns ok
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ cart: [], dropped: [] }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    global.fetch = fetchSpy as unknown as typeof fetch;

    useCartStore.setState({
      items: [baseDomain({ domainName: "local.com" })],
      isInitialized: false,
    });
    await useCartStore.getState().syncWithServer();

    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().items[0].domainName).toBe("local.com");
    expect(useCartStore.getState().isInitialized).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Second call is the POST to save the local cart.
    const lastCall = fetchSpy.mock.calls[1];
    expect(lastCall[1]?.method).toBe("POST");
  });

  it("server-only / local-empty → server cart replaces local", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        cart: [{ domainName: "server.com", price: 999, currency: "INR", registrationPeriod: 1, itemType: "domain" }],
        dropped: [],
      }),
    }) as unknown as typeof fetch;

    useCartStore.setState({ items: [], isInitialized: false });
    await useCartStore.getState().syncWithServer();

    const items = useCartStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].domainName).toBe("server.com");
    expect(useCartStore.getState().isInitialized).toBe(true);
  });

  it("local + server both populated → merges, dedupes by (domainName, itemType), saves back", async () => {
    const fetchSpy = vi
      .fn()
      // GET — server has 1 item
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          cart: [{ domainName: "server.com", price: 999, currency: "INR", registrationPeriod: 1, itemType: "domain" }],
          dropped: [],
        }),
      })
      // POST — save merged cart
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    global.fetch = fetchSpy as unknown as typeof fetch;

    useCartStore.setState({
      items: [
        baseDomain({ domainName: "local.com" }),
        baseDomain({ domainName: "server.com" }), // overlaps with server; should dedup
      ],
      isInitialized: false,
    });
    await useCartStore.getState().syncWithServer();

    const items = useCartStore.getState().items;
    // Merged: server.com (from server) + local.com (only-on-local). 2 items.
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.domainName).sort()).toEqual(["local.com", "server.com"]);
    // Save was made with the merged cart.
    expect(fetchSpy.mock.calls[1][1]?.method).toBe("POST");
  });

  it("short-circuits when isInitialized is already true", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    useCartStore.setState({ items: [baseDomain()], isInitialized: true });
    await useCartStore.getState().syncWithServer();

    // No fetches issued — sync was a no-op.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
