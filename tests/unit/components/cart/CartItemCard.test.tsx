/**
 * Component tests for <CartItemCard> (rescan-4 M14 — cart UI slice 2).
 * Covers the domain-vs-hosting display fork, period-label formatting, the
 * .ai-style min-period annotation, the yearly/monthly billing-cycle lock,
 * the hosting-placeholder "Domain Required" warning, the price math, the
 * multi-year domain price-lock badge, the annual-hosting savings badge,
 * and the onPeriodChange / onRemove callbacks.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import CartItemCard from "@/components/cart/CartItemCard";
import type { CartItem } from "@/lib/types";
import { PRICE_TABLE } from "../../../fixtures/hosting-price-table";

// ResellerOS's hosting prices, as the panel reads them (the savings badge uses the real monthly price).
const hostingPrices = vi.hoisted(() => ({ value: { state: "loading" } as unknown }));
vi.mock("@/hooks/useHostingPrices", () => ({ useHostingPrices: () => hostingPrices.value }));

function domainItem(overrides: Partial<CartItem> = {}): CartItem {
  return {
    domainName: "example.com",
    price: 999,
    currency: "INR",
    registrationPeriod: 1,
    itemType: "domain",
    ...overrides,
  };
}

function hostingItem(overrides: Partial<CartItem> = {}): CartItem {
  return {
    domainName: "hosting-starter-123",
    price: 250,
    currency: "INR",
    registrationPeriod: 12,
    itemType: "hosting",
    hostingPlan: { name: "Starter Hosting" },
    ...overrides,
  };
}

function renderCard(item: CartItem) {
  const onRemove = vi.fn();
  const onPeriodChange = vi.fn();
  render(<CartItemCard item={item} onRemove={onRemove} onPeriodChange={onPeriodChange} />);
  return { onRemove, onPeriodChange };
}

describe("<CartItemCard>", () => {
  it("renders a domain item with domainName + 'year(s) registration' label", () => {
    renderCard(domainItem({ registrationPeriod: 1 }));
    expect(screen.getByRole("heading", { name: "example.com" })).toBeInTheDocument();
    expect(screen.getByText(/1 year\(s\) registration/i)).toBeInTheDocument();
  });

  it("renders a hosting item with hostingPlan.name as the display heading", () => {
    renderCard(hostingItem());
    expect(screen.getByRole("heading", { name: "Starter Hosting" })).toBeInTheDocument();
  });

  it("formats annual hosting period as '1 year subscription'", () => {
    renderCard(hostingItem({ registrationPeriod: 12 }));
    expect(screen.getByText(/1 year subscription/i)).toBeInTheDocument();
  });

  it("formats non-12-month hosting as 'N month(s) subscription'", () => {
    renderCard(hostingItem({ registrationPeriod: 6, billingCycle: undefined }));
    expect(screen.getByText(/6 month\(s\) subscription/i)).toBeInTheDocument();
  });

  it("shows 'Domain Required' warning when hosting placeholder has no linkedDomain", () => {
    renderCard(hostingItem({ linkedDomain: undefined }));
    expect(screen.getByText(/domain required/i)).toBeInTheDocument();
  });

  it("hides 'Domain Required' and shows the linked-domain line once a domain is attached", () => {
    renderCard(hostingItem({ linkedDomain: "example.com" }));
    expect(screen.queryByText(/domain required/i)).not.toBeInTheDocument();
    expect(screen.getByText(/domain: example\.com/i)).toBeInTheDocument();
  });

  it("locks the period UI to '1 Year' when hosting billingCycle is yearly", () => {
    renderCard(hostingItem({ billingCycle: "yearly", registrationPeriod: 12 }));
    expect(screen.getByText("1 Year")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("locks the period UI to '1 Month' when hosting billingCycle is monthly", () => {
    renderCard(hostingItem({ billingCycle: "monthly", registrationPeriod: 1 }));
    expect(screen.getByText("1 Month")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("a domain line: the search price × years plus 18% GST until ResellerOS answers", () => {
    renderCard(domainItem({ price: 999, registrationPeriod: 3, periodUnit: "years" }));
    expect(screen.getByText("₹3,536.46")).toBeInTheDocument();
    expect(screen.getByText(/3 years · incl\. 18% GST/)).toBeInTheDocument();
  });

  it("a domain line: ResellerOS's own price for the term, plus GST, once it has answered", () => {
    render(
      <CartItemCard
        item={domainItem({ price: 999, registrationPeriod: 3, periodUnit: "years" })}
        onRemove={vi.fn()}
        onPeriodChange={vi.fn()}
        termTotals={{ "1": 999, "2": 1990, "3": 2900 }}
      />,
    );
    expect(screen.getByText("₹3,422")).toBeInTheDocument();
    // Only the priced terms are offered.
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["1 Year", "2 Years", "3 Years"]);
  });

  it("shows the multi-year price-lock badge for a domain registered for >1 year", () => {
    renderCard(domainItem({ registrationPeriod: 3 }));
    expect(screen.getByText(/price locked for 3 years/i)).toBeInTheDocument();
    expect(screen.getByText(/no renewal needed until/i)).toBeInTheDocument();
  });

  it("shows the 'Save N%' badge against ResellerOS's real monthly price (9 Oct 2026)", () => {
    hostingPrices.value = { state: "ok", table: PRICE_TABLE };
    // Plus yearly: 2650 incl. GST = 220.8333/mo. Monthly: 441 × 12 = 5292 — not 2 × the yearly rate (5300).
    renderCard(hostingItem({ price: 2650 / 12, registrationPeriod: 12, billingCycle: undefined, hostingPlan: { id: "plus", name: "Plus" } }));
    expect(screen.getByText(/₹2642 off vs monthly billing/)).toBeInTheDocument();
    expect(screen.getByText("Save 50%")).toBeInTheDocument();
    expect(screen.getByText(/₹5292 if paid monthly/)).toBeInTheDocument();
    hostingPrices.value = { state: "loading" };
  });

  it("shows no savings badge while ResellerOS's prices are unknown — never a guessed figure", () => {
    renderCard(hostingItem({ price: 125, registrationPeriod: 12, billingCycle: undefined }));
    expect(screen.queryByText(/off vs monthly billing/)).not.toBeInTheDocument();
  });

  it("annotates the minimum-period option and shows the min-period notice for .ai-style TLDs", () => {
    renderCard(domainItem({ domainName: "myproject.ai", registrationPeriod: 2 }));
    // .ai has minYears: 2 → option '2 Years (Minimum)' is selected; amber notice rendered
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("2");
    expect(screen.getByRole("option", { name: /2 years \(minimum\)/i })).toBeInTheDocument();
    expect(screen.getByText(/\.AI requires min 2 year registration/i)).toBeInTheDocument();
  });

  // 9 Oct 2026: a domain's options are years and are saved as years ("months" made 3 years
  // read as 3 months once the term went to ResellerOS), and only 1, 2, 3, 5 are offered.
  it("fires onPeriodChange with (domainName, parsedYear, itemType, 'years') when the select changes", async () => {
    const user = userEvent.setup();
    const { onPeriodChange } = renderCard(domainItem({ registrationPeriod: 1 }));
    await user.selectOptions(screen.getByRole("combobox"), "3");
    expect(onPeriodChange).toHaveBeenCalledWith("example.com", 3, "domain", "years");
  });

  it("offers a domain only the terms ResellerOS sells: 1, 2, 3, 5 years", () => {
    renderCard(domainItem({ registrationPeriod: 1 }));
    const values = Array.from((screen.getByRole("combobox") as HTMLSelectElement).options).map((o) => o.value);
    expect(values).toEqual(["1", "2", "3", "5"]);
  });

  it("fires onRemove with (domainName, itemType) when the trash button is clicked", async () => {
    const user = userEvent.setup();
    const { onRemove } = renderCard(domainItem());
    await user.click(screen.getByRole("button", { name: "Remove example.com" }));
    expect(onRemove).toHaveBeenCalledWith("example.com", "domain");
  });
});
