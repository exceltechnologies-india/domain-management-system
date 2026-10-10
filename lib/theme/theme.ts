/**
 * The Customer Portal's theme, as data (Pawan, 10 Oct 2026: "Make our color themes dynamic … if
 * ResellerOS changes it should be easy … modular … better SaaS approach").
 *
 * ResellerOS owns the brand: its lib/theme/tokens.ts, served at GET /api/public/theme. DMS reads it
 * at runtime (fetch-theme.ts) and renders it as CSS custom properties on `.ros-theme`, the portal's
 * root (PortalThemeStyle). DEFAULT_THEME is the bundled fallback for when ResellerOS can't be
 * reached; a test pins it to ResellerOS's tokens.ts so the fallback never drifts either.
 *
 * Every value is validated against a strict pattern before it reaches a <style> tag, so a bad or
 * hostile response can only fall back to the default — never inject CSS.
 */

export const THEME_TOKEN_NAMES = [
  "paper", "paper-2",
  "ink", "ink-2", "ink-3", "ink-4",
  "hairline", "hairline-strong",
  "amber", "amber-soft", "amber-ink",
  "emerald", "emerald-soft", "emerald-ink",
  "rose", "rose-soft", "rose-ink",
  "indigo", "indigo-soft", "indigo-ink",
  "slate", "slate-soft",
] as const;
export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];
export type ThemeTokens = Record<ThemeTokenName, string>;

export const ACCENT_STEPS = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900"] as const;
export type AccentStep = (typeof ACCENT_STEPS)[number];

export interface PortalTheme {
  version: string;
  scope: string;
  /** The accent's tint scale as RGB triplets — DMS's `primary-*` palette is RGB-based. */
  accentScale: Record<AccentStep, string>;
  light: ThemeTokens;
  dark: ThemeTokens;
}

/** Bundled copy of ResellerOS's APP_THEME (lib/theme/tokens.ts there), version 2026-10-10. */
export const DEFAULT_THEME: PortalTheme = {
  version: "2026-10-10",
  scope: "platform",
  accentScale: {
    "50": "255 247 237", "100": "255 237 213", "200": "254 215 170", "300": "253 186 116", "400": "251 146 60",
    "500": "234 88 12", "600": "194 65 12", "700": "159 52 9", "800": "124 45 18", "900": "67 20 7",
  },
  light: {
    paper: "45 33% 97%", "paper-2": "40 22% 94%",
    ink: "24 13% 9%", "ink-2": "28 9% 32%", "ink-3": "33 7% 41%", "ink-4": "35 9% 64%",
    hairline: "38 25% 87%", "hairline-strong": "38 18% 75%",
    amber: "20 91% 41%", "amber-soft": "28 100% 95%", "amber-ink": "18 87% 33%",
    emerald: "142 71% 28%", "emerald-soft": "138 50% 92%", "emerald-ink": "142 71% 22%",
    rose: "0 76% 50%", "rose-soft": "0 86% 96%", "rose-ink": "0 74% 37%",
    indigo: "240 65% 42%", "indigo-soft": "232 100% 95%", "indigo-ink": "244 55% 32%",
    slate: "215 25% 35%", "slate-soft": "210 25% 95%",
  },
  dark: {
    paper: "24 10% 8%", "paper-2": "28 8% 12%",
    ink: "45 33% 97%", "ink-2": "33 7% 75%", "ink-3": "33 7% 55%", "ink-4": "33 6% 42%",
    hairline: "28 8% 20%", "hairline-strong": "28 8% 30%",
    amber: "20 95% 55%", "amber-soft": "22 50% 18%", "amber-ink": "28 100% 80%",
    emerald: "142 71% 50%", "emerald-soft": "142 30% 15%", "emerald-ink": "142 70% 75%",
    rose: "0 86% 65%", "rose-soft": "0 40% 18%", "rose-ink": "0 90% 80%",
    indigo: "240 65% 65%", "indigo-soft": "232 30% 18%", "indigo-ink": "232 50% 80%",
    slate: "215 25% 65%", "slate-soft": "215 20% 18%",
  },
};

const HSL = /^\d{1,3}(\.\d+)? \d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$/;
const RGB = /^\d{1,3} \d{1,3} \d{1,3}$/;

function tokens(raw: unknown): ThemeTokens | null {
  if (!raw || typeof raw !== "object") return null;
  const out = {} as ThemeTokens;
  for (const name of THEME_TOKEN_NAMES) {
    const v = (raw as Record<string, unknown>)[name];
    if (typeof v !== "string" || !HSL.test(v.trim())) return null;
    out[name] = v.trim();
  }
  return out;
}

/** A theme from an untrusted body, or null when ANY value is missing or not a plain colour triplet. */
export function parseTheme(body: unknown): PortalTheme | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const light = tokens(b.light);
  const dark = tokens(b.dark);
  const scale = b.accentScale as Record<string, unknown> | undefined;
  if (!light || !dark || !scale || typeof scale !== "object") return null;
  const accentScale = {} as Record<AccentStep, string>;
  for (const step of ACCENT_STEPS) {
    const v = scale[step];
    if (typeof v !== "string" || !RGB.test(v.trim())) return null;
    accentScale[step] = v.trim();
  }
  const version = typeof b.version === "string" && /^[\w.-]{1,40}$/.test(b.version) ? b.version : "unknown";
  const scope = typeof b.scope === "string" && /^[a-z]{1,20}$/.test(b.scope) ? b.scope : "platform";
  return { version, scope, accentScale, light, dark };
}

function declarations(t: ThemeTokens, scale?: Record<AccentStep, string>): string {
  const lines = THEME_TOKEN_NAMES.map((n) => `  --${n}: ${t[n]};`);
  if (scale) lines.push(...ACCENT_STEPS.map((s) => `  --primary-${s}: ${scale[s]};`));
  return lines.join("\n");
}

/**
 * The CSS for a theme on `selector` (light), and its dark variant under `.dark`. Only validated
 * values reach here (parseTheme / DEFAULT_THEME).
 */
export function themeToCss(theme: PortalTheme, selector = ".ros-theme"): string {
  return [
    `/* ResellerOS theme ${theme.version} (${theme.scope}) */`,
    `${selector} {\n${declarations(theme.light, theme.accentScale)}\n}`,
    `.dark ${selector}, ${selector}.dark {\n${declarations(theme.dark)}\n}`,
  ].join("\n");
}
