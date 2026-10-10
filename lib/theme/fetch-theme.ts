/**
 * Read ResellerOS's theme, server-side (GET <RESELLEROS_SERVER_URL>/api/public/theme).
 *
 * Kept for five minutes; a failure is remembered for one minute so an unreachable ResellerOS does
 * not slow every page, and the portal then renders the bundled DEFAULT_THEME. Never throws: a page
 * always gets a theme.
 */
import { DEFAULT_THEME, parseTheme, type PortalTheme } from "./theme";

export interface FetchThemeOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
  timeoutMs?: number;
}

export type ThemeSource = "reselleros" | "default";

const OK_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 60_000;
let cached: { at: number; ttl: number; base: string; theme: PortalTheme; source: ThemeSource } | null = null;

/** Tests only. */
export function resetThemeCache(): void {
  cached = null;
}

export async function fetchPortalTheme(options: FetchThemeOptions = {}): Promise<{ theme: PortalTheme; source: ThemeSource }> {
  const env = options.env ?? process.env;
  const raw = (env.RESELLEROS_SERVER_URL ?? "").trim();
  if (!/^https?:\/\//i.test(raw)) return { theme: DEFAULT_THEME, source: "default" };
  const base = raw.replace(/\/+$/, "");
  const now = (options.now ?? Date.now)();
  if (cached && cached.base === base && now - cached.at < cached.ttl) return { theme: cached.theme, source: cached.source };

  let theme: PortalTheme | null = null;
  try {
    const res = await (options.fetchImpl ?? fetch)(`${base}/api/public/theme`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? 1500),
    });
    if (res.status === 200) theme = parseTheme(await res.json().catch(() => null));
  } catch {
    theme = null;
  }
  cached = theme
    ? { at: now, ttl: OK_TTL_MS, base, theme, source: "reselleros" }
    : { at: now, ttl: FAIL_TTL_MS, base, theme: DEFAULT_THEME, source: "default" };
  return { theme: cached.theme, source: cached.source };
}
