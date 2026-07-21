/**
 * Registry of public marketing pages whose publish/draft visibility is
 * managed from the admin panel (Admin → Pages).
 *
 * A page set to `draft` is redirected to the homepage for the public, while
 * a logged-in admin can still view it (preview). Enforcement is server-side
 * (see `lib/services/page-visibility.ts` + the `(marketing)` route-group
 * layout) — NOT in middleware, which runs on the Edge runtime and cannot
 * reach MongoDB.
 *
 * Status is stored as a single map in the Settings collection under the
 * `page_visibility` key: `{ [slug]: 'published' | 'draft' }`.
 */

export type PageStatus = "published" | "draft";

export interface ManagedPage {
  /** Stable id — the key inside the page_visibility settings map. */
  slug: string;
  /** Human label shown in the admin manager. */
  title: string;
  /** Public URL this page serves. */
  path: string;
  /** Short helper text shown under the title in the admin manager. */
  description: string;
  /**
   * When true the page can never be set to draft. The homepage is locked
   * because drafting the redirect target ('/') would create a redirect loop.
   */
  lockedPublished?: boolean;
}

/** The settings key holding the `{ slug: status }` map. */
export const PAGE_VISIBILITY_SETTING_KEY = "page_visibility";

/** Default status for any managed page without an explicit stored value. */
export const DEFAULT_PAGE_STATUS: PageStatus = "published";

/**
 * Main marketing pages (operator-chosen scope). Legal pages
 * (privacy/terms/refund) are deliberately excluded — drafting them can have
 * compliance implications.
 */
export const MANAGED_PAGES: ManagedPage[] = [
  {
    slug: "hosting",
    title: "Hosting",
    path: "/hosting",
    description: "Web hosting plans and the 15-day free-trial signup.",
  },
  {
    slug: "about",
    title: "About Us",
    path: "/about",
    description: "Company / about page.",
  },
  {
    slug: "contact",
    title: "Contact",
    path: "/contact",
    description: "Contact page with the enquiry form.",
  },
  {
    slug: "domains-home",
    title: "Domains Landing",
    path: "/domains-home",
    description: "The domain-focused landing (former homepage). Draft it to redirect visitors to the homepage.",
  },
];

export function getManagedPageBySlug(slug: string): ManagedPage | undefined {
  return MANAGED_PAGES.find((p) => p.slug === slug);
}

export function getManagedPageByPath(path: string): ManagedPage | undefined {
  return MANAGED_PAGES.find((p) => p.path === path);
}
