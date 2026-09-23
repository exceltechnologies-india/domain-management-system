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
 *  - inside a shell, AdminLayout renders ONLY its children (otherwise every
 *    page draws a second sidebar inside the first);
 *  - outside one, it still renders its chrome — app/admin/layout.tsx mounts it
 *    that way, so that branch is live and must stay.
 *
 * AdminLayoutSkeleton used to be tested here the same way, and that pairing
 * was wrong. Its header claimed the chrome was "used outside /admin too", and
 * a test rendered it with no provider and asserted the chrome appeared. Every
 * one of its 19 importers was under app/admin, where the shell is always
 * mounted — so the guard always fired, the dark-blue chrome could never run,
 * and the only thing keeping it alive was a test exercising a configuration no
 * caller produces (AGENTS.md L111). Component and wrappers are deleted; what
 * replaces those assertions is the invariant that made them pointless, below:
 * every admin route sits under app/admin/layout.tsx, so no page needs a shell
 * of its own.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/dashboard" }));
vi.mock("@/components/admin/SessionExpiredBanner", () => ({ default: () => null }));

import AdminLayout from "@/components/admin/AdminLayout";
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

  it("provides the flag as true, so the pages' own wrappers pass through", async () => {
    // `value={false}` would compile, pass every component test above, and put
    // a second sidebar back on every admin page.
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/admin/layout.tsx", "utf8");
    expect(src).toMatch(/AdminShellContext\.Provider\s+value=\{true\}/);
  });

  it("no admin page hand-rolls its own logout", async () => {
    /**
     * Five pages passed `onLogout={() => { window.location.href = "/login" }}`.
     * That navigates WITHOUT clearing the NextAuth session or storage, which
     * `performLogout` does — so if it ever ran, the operator would land on
     * /login still authenticated.
     *
     * It never ran: inside the shell AdminLayout returns only its children, so
     * a page's onLogout is dead, and the shell passes the real one. That is
     * what made it survive — wrong AND unreachable, indistinguishable from
     * live code, exactly like the dark-blue skeleton chrome deleted above.
     *
     * Kept as a scan rather than left to review because the props are dead:
     * nothing renders them, so no component test can see one go wrong again.
     */
    const fs = await import("node:fs");
    const path = await import("node:path");
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir).flatMap((e) => {
        const f = path.join(dir, e);
        return fs.statSync(f).isDirectory() ? walk(f) : f.endsWith(".tsx") ? [f] : [];
      });
    const pages = walk("app/admin");
    expect(pages.length).toBeGreaterThan(15);

    const offenders = pages.filter((f) =>
      /onLogout=\{\(\)\s*=>/.test(fs.readFileSync(f, "utf8"))
    );
    expect(
      offenders,
      "pass performLogout (or a handler that calls it) — an inline navigation " +
        "leaves the NextAuth session and localStorage intact."
    ).toEqual([]);
  });

  it("no admin page renders a shell skeleton of its own any more", async () => {
    /**
     * This replaces the two AdminLayoutSkeleton tests that were deleted, and
     * it is the invariant that made them pointless: every route under
     * app/admin is inside the shell above, so a page-level shell skeleton can
     * only ever be a passthrough. Nineteen pages wrapped their loading branch
     * in one; the component is gone and so are the wrappers.
     *
     * A scan rather than a component test, because what must stay true is an
     * ABSENCE across 19 files — the same reason the layout check above is a
     * scan.
     */
    const fs = await import("node:fs");
    const path = await import("node:path");
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir).flatMap((e) => {
        const f = path.join(dir, e);
        return fs.statSync(f).isDirectory() ? walk(f) : f.endsWith(".tsx") ? [f] : [];
      });
    const pages = walk("app/admin");
    // Guard the guard: a moved directory would make this vacuous.
    expect(pages.length).toBeGreaterThan(15);

    const offenders = pages.filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      return /<AdminLayoutSkeleton/.test(code);
    });
    expect(offenders).toEqual([]);
  });
});
