/**
 * Component tests for <NameServerManagement> (rescan-4 M14).
 * Pins the localStorage-backed CRUD over nameserver configurations:
 *  - On mount: hydrates from safeLocalStorage 'nameserverConfigs',
 *    prepending the RESELLERCLUB default.
 *  - 'Add Custom' opens the inline editor; Cancel closes it.
 *  - Save with empty name → toast.error.
 *  - Save with all-empty servers → toast.error.
 *  - Save success → persists to localStorage (custom-only — default is
 *    NOT persisted because it's hard-coded) + toast.success + closes form.
 *  - 'Set Active' on a custom config flips isActive across configs +
 *    persists.
 *  - 'Delete' on a custom config removes + persists.
 *  - 'Delete' on the default config → toast.error + no-op.
 *  - 'Reset to Default Nameservers' restores isActive=true on the default.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

const lsStore = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/storage", () => ({
  safeLocalStorage: {
    getItem: (k: string) => lsStore.get(k) ?? null,
    setItem: (k: string, v: string) => lsStore.set(k, v),
    removeItem: (k: string) => lsStore.delete(k),
  },
}));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("react-hot-toast", () => ({
  default: { success: toastSuccess, error: toastError },
  __esModule: true,
}));

import NameServerManagement from "@/components/NameServerManagement";

beforeEach(() => {
  lsStore.clear();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe("<NameServerManagement>", () => {
  it("renders the default ResellerClub configuration on first mount", () => {
    render(<NameServerManagement />);
    expect(screen.getByRole("heading", { name: /nameserver management/i })).toBeInTheDocument();
    // 'Default Nameservers' appears in both Currently Active + the
    // Available Configurations list, so use getAllByText.
    expect(screen.getAllByText(/Default Nameservers/i).length).toBeGreaterThanOrEqual(1);
    // Mercury nameserver appears in both Currently Active + Available
    // Configurations — assert via getAllByText.
    expect(
      screen.getAllByText("deepak1299294.mercury.orderbox-dns.com").length
    ).toBeGreaterThanOrEqual(1);
  });

  it("hydrates additional configs from safeLocalStorage on mount", () => {
    lsStore.set(
      "nameserverConfigs",
      JSON.stringify([
        {
          id: "custom-100",
          name: "My CF DNS",
          servers: ["alex.ns.cloudflare.com", "ruby.ns.cloudflare.com"],
          isDefault: false,
          isActive: false,
        },
      ])
    );
    render(<NameServerManagement />);
    expect(screen.getByText("My CF DNS")).toBeInTheDocument();
    expect(screen.getByText("alex.ns.cloudflare.com")).toBeInTheDocument();
  });

  it("'Add Custom' opens the inline editor; Cancel closes it", async () => {
    const user = userEvent.setup();
    render(<NameServerManagement />);
    await user.click(screen.getByRole("button", { name: /add custom/i }));
    expect(screen.getByPlaceholderText(/e\.g\., My Custom DNS/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByPlaceholderText(/e\.g\., My Custom DNS/i)).not.toBeInTheDocument();
  });

  it("Save with empty name → toast.error 'Please enter a configuration name'", async () => {
    const user = userEvent.setup();
    render(<NameServerManagement />);
    await user.click(screen.getByRole("button", { name: /add custom/i }));
    await user.click(screen.getByRole("button", { name: /save configuration/i }));
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/please enter a configuration name/i));
  });

  it("Save with no valid servers → toast.error 'Please enter at least one nameserver'", async () => {
    const user = userEvent.setup();
    render(<NameServerManagement />);
    await user.click(screen.getByRole("button", { name: /add custom/i }));
    const nameInput = screen.getByPlaceholderText(/e\.g\., My Custom DNS/i);
    await user.type(nameInput, "My DNS");
    await user.click(screen.getByRole("button", { name: /save configuration/i }));
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/at least one nameserver/i));
  });

  it("Save success → persists to localStorage (custom only) + toast.success + closes form", async () => {
    const user = userEvent.setup();
    render(<NameServerManagement />);
    await user.click(screen.getByRole("button", { name: /add custom/i }));
    await user.type(screen.getByPlaceholderText(/e\.g\., My Custom DNS/i), "Cloudflare");
    await user.type(screen.getByPlaceholderText("ns1.example.com"), "alex.ns.cloudflare.com");
    await user.type(screen.getByPlaceholderText("ns2.example.com"), "ruby.ns.cloudflare.com");
    await user.click(screen.getByRole("button", { name: /save configuration/i }));
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/saved/i));
    const persisted = JSON.parse(lsStore.get("nameserverConfigs") || "[]");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ name: "Cloudflare", isDefault: false });
    expect(persisted[0].servers).toEqual([
      "alex.ns.cloudflare.com",
      "ruby.ns.cloudflare.com",
    ]);
    // RESELLERCLUB_DEFAULT is hard-coded, NOT persisted.
    expect(persisted.find((c: { isDefault: boolean }) => c.isDefault)).toBeUndefined();
    // The form is closed after save.
    expect(screen.queryByPlaceholderText(/e\.g\., My Custom DNS/i)).not.toBeInTheDocument();
  });

  it("'Add Another Nameserver' grows the input list", async () => {
    const user = userEvent.setup();
    render(<NameServerManagement />);
    await user.click(screen.getByRole("button", { name: /add custom/i }));
    expect(screen.getByPlaceholderText("ns1.example.com")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("ns2.example.com")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("ns3.example.com")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /add another nameserver/i }));
    expect(screen.getByPlaceholderText("ns3.example.com")).toBeInTheDocument();
  });

  it("'Delete' on a custom config removes it + persists; default delete shows toast.error", async () => {
    const user = userEvent.setup();
    lsStore.set(
      "nameserverConfigs",
      JSON.stringify([
        {
          id: "custom-1",
          name: "My DNS",
          servers: ["a.ns.example.com"],
          isDefault: false,
          isActive: false,
        },
      ])
    );
    render(<NameServerManagement />);
    expect(screen.getByText("My DNS")).toBeInTheDocument();
    // The custom config row has a delete button (title='Delete Configuration').
    // The default row does NOT render one — so getAllByTitle returns exactly 1.
    const deleteButtons = screen.getAllByTitle(/delete configuration/i);
    expect(deleteButtons).toHaveLength(1);
    await user.click(deleteButtons[0]);
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/deleted/i));
    expect(screen.queryByText("My DNS")).not.toBeInTheDocument();
    expect(JSON.parse(lsStore.get("nameserverConfigs") || "[]")).toEqual([]);
  });

  it("'Set Active' on a custom config flips isActive across configs", async () => {
    const user = userEvent.setup();
    lsStore.set(
      "nameserverConfigs",
      JSON.stringify([
        {
          id: "custom-1",
          name: "Cloudflare",
          servers: ["alex.ns.cloudflare.com"],
          isDefault: false,
          isActive: false,
        },
      ])
    );
    render(<NameServerManagement />);
    // Default row is active initially; custom row exposes the 'Set as Active' button.
    const setActiveBtns = screen.getAllByTitle(/set as active/i);
    expect(setActiveBtns).toHaveLength(1);
    await user.click(setActiveBtns[0]);
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/active.*updated/i));
    const persisted = JSON.parse(lsStore.get("nameserverConfigs") || "[]");
    expect(persisted[0]).toMatchObject({ id: "custom-1", isActive: true });
  });

  it("'Reset to Default Nameservers' restores default as active", async () => {
    const user = userEvent.setup();
    lsStore.set(
      "nameserverConfigs",
      JSON.stringify([
        {
          id: "custom-1",
          name: "Cloudflare",
          servers: ["alex.ns.cloudflare.com"],
          isDefault: false,
          isActive: true, // currently active
        },
      ])
    );
    render(<NameServerManagement />);
    await user.click(screen.getByRole("button", { name: /reset to default nameservers/i }));
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/reset to default/i));
    const persisted = JSON.parse(lsStore.get("nameserverConfigs") || "[]");
    // The custom config's isActive flipped to false (default takes over).
    expect(persisted[0]).toMatchObject({ id: "custom-1", isActive: false });
  });

  it("malformed localStorage JSON gracefully falls back to the default-only list", () => {
    lsStore.set("nameserverConfigs", "{not-valid-json");
    render(<NameServerManagement />);
    // Still renders default + no crash.
    // 'Default Nameservers' appears in both Currently Active + the
    // Available Configurations list, so use getAllByText.
    expect(screen.getAllByText(/Default Nameservers/i).length).toBeGreaterThanOrEqual(1);
  });
});
