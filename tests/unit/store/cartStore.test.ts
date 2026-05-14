import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub localStorage-dependent storage and server sync
vi.mock("@/lib/storage", () => ({
  safeLocalStorage: {
    getItem: vi.fn().mockReturnValue(null), // no token → no server sync
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

vi.mock("zustand/middleware", async () => {
  const actual = await vi.importActual<typeof import("zustand/middleware")>("zustand/middleware");
  return {
    ...actual,
    persist: (fn: any) => fn, // strip persistence in tests
    createJSONStorage: vi.fn(),
  };
});

describe("cartStore", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("addItem adds a new domain item", async () => {
    const { useCartStore } = await import("@/store/cartStore");
    const store = useCartStore.getState();
    store.clearCart();

    store.addItem({
      domainName: "example.com",
      price: 999,
      registrationPeriod: 1,
      itemType: "domain",
    } as any);

    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().items[0].domainName).toBe("example.com");
  });

  it("addItem deduplicates the same domain+type", async () => {
    const { useCartStore } = await import("@/store/cartStore");
    const store = useCartStore.getState();
    store.clearCart();

    const item = { domainName: "example.com", price: 999, registrationPeriod: 1, itemType: "domain" } as any;
    store.addItem(item);
    store.addItem({ ...item, price: 1200 }); // update price via add

    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().items[0].price).toBe(1200);
  });

  it("removeItem removes the correct item", async () => {
    const { useCartStore } = await import("@/store/cartStore");
    const store = useCartStore.getState();
    store.clearCart();

    store.addItem({ domainName: "a.com", price: 500, registrationPeriod: 1, itemType: "domain" } as any);
    store.addItem({ domainName: "b.com", price: 600, registrationPeriod: 1, itemType: "domain" } as any);
    store.removeItem("a.com", "domain");

    const items = useCartStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].domainName).toBe("b.com");
  });

  it("getTotalPrice returns correct sum", async () => {
    const { useCartStore } = await import("@/store/cartStore");
    const store = useCartStore.getState();
    store.clearCart();

    store.addItem({ domainName: "a.com", price: 500, registrationPeriod: 2, itemType: "domain" } as any);
    store.addItem({ domainName: "b.com", price: 300, registrationPeriod: 1, itemType: "domain" } as any);

    expect(useCartStore.getState().getTotalPrice()).toBe(1300);
  });

  it("enforces .ai minimum 2-year registration period", async () => {
    const { useCartStore } = await import("@/store/cartStore");
    const store = useCartStore.getState();
    store.clearCart();

    store.addItem({ domainName: "test.ai", price: 2000, registrationPeriod: 1, itemType: "domain" } as any);

    expect(useCartStore.getState().items[0].registrationPeriod).toBe(2);
  });
});
