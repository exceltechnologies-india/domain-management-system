/**
 * The admin shell must be mounted ONCE, by app/admin/layout.tsx.
 *
 * Why this file exists: /admin had no layout.tsx, so all 25 pages rendered
 * `<AdminLayout>` themselves. Every client-side navigation unmounted the whole
 * shell and built a new one, with the page's `<AdminLayoutSkeleton>` — whose
 * sidebar is `bg-blue-900`, left over from before the ResellerOS restyle —
 * flashing in between. Measured on a real navigation: the sidebar node was
 * replaced, and at some frames no sidebar existed and the nav held 0 links.
 * That was the reported "sidebar flickers like a broken UI element".
 *
 * The fix is a route layout plus a context flag, so the pages' own wrappers
 * become passthroughs instead of needing 25 files rewritten at once. These
 * tests pin the two halves that make that safe:
 *
 *  - inside a shell, AdminLayout and AdminLayoutSkeleton render ONLY children
 *    (otherwise every page draws a second sidebar inside the first);
 *  - outside one, both still render their chrome (the skeleton is used outside
 *    /admin too, and a passthrough there would leave a page with no shell).
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/dashboard" }));
vi.mock("@/components/admin/SessionExpiredBanner", () => ({ default: () => null }));

import AdminLayout from "@/components/admin/AdminLayout";
import { AdminLayoutSkeleton } from "@/components/skeletons/AdminLayout";
import { AdminShellContext } from "@/components/admin/AdminShellContext";

const USER = { firstName: "Local", lastName: "Dev", role: "admin" };

function insideShell(node: React.ReactNode) {
  return render(
    <AdminShellContext.Provider value={true}>{node}</AdminShellContext.Provider>
  );
}

describe("AdminLayout — nested inside a shell", () => {
  it("renders only its children: no second sidebar", () => {
    insideShell(
      <AdminLayout user={USER}>
        <p>page body</p>
      </AdminLayout>
    );
    expect(screen.getByText("page body")).toBeInTheDocument();
    // The shell's own landmarks must NOT be duplicated.
    expect(document.querySelectorAll("nav")).toHaveLength(0);
    expect(screen.queryByText("Admin Panel")).not.toBeInTheDocument();
  });
});

describe("AdminLayout — standalone (no shell above)", () => {
  it("still renders the chrome, so a page outside /admin is not left bare", () => {
    render(
      <AdminLayout user={USER}>
        <p>page body</p>
      </AdminLayout>
    );
    expect(screen.getByText("page body")).toBeInTheDocument();
    expect(document.querySelectorAll("nav")).toHaveLength(1);
    expect(screen.getByText("Admin Panel")).toBeInTheDocument();
  });
});

describe("AdminLayoutSkeleton — nested inside a shell", () => {
  it("renders only its children, so the dark-blue shell never flashes", () => {
    const { container } = insideShell(
      <AdminLayoutSkeleton>
        <p>content skeleton</p>
      </AdminLayoutSkeleton>
    );
    expect(screen.getByText("content skeleton")).toBeInTheDocument();
    // bg-blue-900 is the pre-restyle sidebar. Seeing it mid-navigation is the
    // entire reported bug, so assert on that exact class, not on a vaguer proxy.
    expect(container.innerHTML).not.toContain("bg-blue-900");
    expect(container.querySelector("aside")).toBeNull();
  });
});

describe("AdminLayoutSkeleton — standalone", () => {
  it("still renders its own chrome outside /admin", () => {
    const { container } = render(
      <AdminLayoutSkeleton>
        <p>content skeleton</p>
      </AdminLayoutSkeleton>
    );
    expect(screen.getByText("content skeleton")).toBeInTheDocument();
    expect(container.querySelector("aside")).not.toBeNull();
  });
});

describe("the route layout exists at all", () => {
  it("app/admin/layout.tsx is present and mounts the shell", async () => {
    // A source scan, because the bug was an ABSENCE — no layout file — and an
    // absence is exactly what a component test cannot see. Deleting the file
    // must fail something.
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/admin/layout.tsx", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("AdminLayout");
    expect(code).toContain("AdminShellContext.Provider");
    // Guard the guard: the comment strip must not have eaten the file.
    expect(code).toContain("export default");
  });
});
