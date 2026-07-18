/**
 * Publish/draft visibility for the managed marketing pages.
 *
 * Backed by a single Settings doc (`page_visibility`) holding a
 * `{ [slug]: 'published' | 'draft' }` map, so it rides the existing settings
 * cache. Server-only (touches MongoDB via the settings service) — never
 * import from Edge middleware.
 */

import { getSettingValue, upsertSetting } from "@/lib/services/settings";
import {
  MANAGED_PAGES,
  PAGE_VISIBILITY_SETTING_KEY,
  getManagedPageBySlug,
  getManagedPageByPath,
  type PageStatus,
} from "@/config/managed-pages";

type StatusMap = Record<string, PageStatus>;

async function readStoredMap(): Promise<StatusMap> {
  const stored = await getSettingValue<StatusMap>(PAGE_VISIBILITY_SETTING_KEY, {});
  return stored && typeof stored === "object" ? stored : {};
}

function resolve(slug: string, stored: StatusMap): PageStatus {
  const page = getManagedPageBySlug(slug);
  if (page?.lockedPublished) return "published";
  return stored[slug] === "draft" ? "draft" : "published";
}

/** Full status map for every managed page (locked pages always 'published'). */
export async function getPageStatusMap(): Promise<StatusMap> {
  const stored = await readStoredMap();
  const map: StatusMap = {};
  for (const p of MANAGED_PAGES) map[p.slug] = resolve(p.slug, stored);
  return map;
}

/** Status for a single managed page by slug. */
export async function getPageStatus(slug: string): Promise<PageStatus> {
  return resolve(slug, await readStoredMap());
}

/**
 * Whether a public (non-admin) visitor should be blocked from this path.
 * Unmanaged paths and the homepage are never blocked.
 */
export async function isPathDraftForPublic(path: string): Promise<boolean> {
  const page = getManagedPageByPath(path);
  if (!page || page.lockedPublished) return false;
  return (await getPageStatus(page.slug)) === "draft";
}

/** Set a managed page's status. Locked pages cannot be drafted. */
export async function setPageStatus(
  slug: string,
  status: PageStatus,
  updatedBy = "system",
): Promise<void> {
  const page = getManagedPageBySlug(slug);
  if (!page) throw new Error(`Unknown managed page: ${slug}`);
  if (page.lockedPublished && status === "draft") {
    throw new Error(`"${page.title}" cannot be set to draft.`);
  }
  const stored = await readStoredMap();
  const next: StatusMap = { ...stored, [slug]: status };
  await upsertSetting(PAGE_VISIBILITY_SETTING_KEY, next, {
    category: "pages",
    description: "Publish/draft status per managed marketing page.",
    updatedBy,
  });
}
