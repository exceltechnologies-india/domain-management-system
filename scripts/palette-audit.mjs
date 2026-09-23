/**
 * Measure the DMS palette conversion honestly.
 *
 * Todos records the previous headline as wrong in BOTH directions: inflated by
 * dead components, and understated because the pattern missed directional
 * utilities, bg-white, ring-* and gradient stops. Two corrections here:
 *
 * 1. LEGACY = a stock Tailwind family with a NUMERIC suffix. That single rule
 *    gets the token boundary right for free: `bg-emerald-50` is a raw Tailwind
 *    scale and legacy, `bg-emerald-soft` is a token from tailwind.config.js and
 *    is not. `primary-600` is a token too, so that family is simply not listed.
 *
 * 2. REACHABLE is resolved by walking the import graph from app/ entrypoints,
 *    not by asking "does any file under app/ mention it". The note in Todos
 *    says that proxy was wrong in both directions — FooterClassic, CustomToast
 *    and LoadingComponents are reached through intermediaries.
 *
 * Every count this prints is a measurement of source text. It says nothing
 * about whether a converted screen still LOOKS right; jsdom does no layout and
 * neither does a regex (AGENTS.md L16).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, so this runs from anywhere: `node scripts/palette-audit.mjs`. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FAMILIES = [
  "gray", "slate", "zinc", "neutral", "stone", "blue", "red", "green", "yellow",
  "purple", "pink", "orange", "teal", "cyan", "sky", "violet", "fuchsia", "lime",
  "amber", "emerald", "rose", "indigo",
].join("|");
const UTILS =
  "bg|text|border|ring|from|to|via|divide|outline|decoration|shadow|accent|caret|fill|stroke|placeholder";
// (-[trblxyse])? covers the directional forms: border-t-, divide-x-, border-s-.
const LEGACY = new RegExp(
  "\\b(?:" + UTILS + ")(?:-[trblxyse])?-(?:" + FAMILIES + ")-\\d{2,3}\\b",
  "g"
);
const PLAIN = new RegExp(
  "\\b(?:" + UTILS + ")(?:-[trblxyse])?-(?:white|black)\\b",
  "g"
);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * Walk lib/, hooks/, store/ and middleware/ as well as components/ and app/.
 *
 * The first version walked only components/ and app/, and reported CustomToast
 * as unreachable. Todos already records that it is reached through
 * lib/toast.tsx — so the graph had exactly the blind spot the note warns
 * about, in a new form. A file cannot be judged dead by a graph that does not
 * contain the thing importing it.
 */
const files = [
  ...walk(join(ROOT, "components")),
  ...walk(join(ROOT, "app")),
  ...walk(join(ROOT, "lib")),
  ...walk(join(ROOT, "hooks")),
  ...walk(join(ROOT, "store")),
  ...walk(join(ROOT, "middleware")),
];

/** Resolve an import specifier to a file on disk, or null. */
function resolveImport(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  const candidates = [
    base + ".tsx",
    base + ".ts",
    join(base, "index.tsx"),
    join(base, "index.ts"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const importsOf = new Map();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const specs = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  importsOf.set(f, specs.map((s) => resolveImport(s, f)).filter(Boolean));
}

/** Entrypoints: every Next special file under app/. */
const ENTRY_NAMES = new Set([
  "page.tsx", "page.ts", "layout.tsx", "layout.ts", "template.tsx",
  "error.tsx", "not-found.tsx", "global-error.tsx", "loading.tsx", "default.tsx",
]);
const appDir = join(ROOT, "app") + sep;
const rootMiddleware = join(ROOT, "middleware.ts");
const entry = [
  ...files.filter(
    (f) => f.startsWith(appDir) && ENTRY_NAMES.has(f.slice(f.lastIndexOf(sep) + 1))
  ),
  ...(existsSync(rootMiddleware) ? [rootMiddleware] : []),
];
if (existsSync(rootMiddleware) && !importsOf.has(rootMiddleware)) {
  const src = readFileSync(rootMiddleware, "utf8");
  const specs = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  importsOf.set(rootMiddleware, specs.map((x) => resolveImport(x, rootMiddleware)).filter(Boolean));
}

/**
 * REACHABLE BY IMPORT IS NOT THE SAME AS SERVED.
 *
 * Six DMS routes 307 to ResellerOS once it is the front door — `/` plus the
 * five in RESELLEROS_OWNED_PAGES. Their page components are still imported, so
 * the graph calls them reachable, and a count that stops there proposes work on
 * screens no visitor can arrive at. HostingLanding.tsx, the single biggest file
 * in the whole repo at 158, is only reached through `/`.
 *
 * So the graph is walked twice and the difference is reported. Anything only
 * reachable through a redirected route is listed separately rather than
 * dropped — standalone DMS still serves every one of them.
 */
const REDIRECTED_ROUTES = [
  "app" + sep + "page.tsx",
  "app" + sep + "privacy" + sep,
  "app" + sep + "terms-and-conditions" + sep,
  "app" + sep + "cancellation-refund" + sep,
  "app" + sep + "contact" + sep,
  "app" + sep + "about" + sep,
];
const isRedirected = (f) => {
  const rel = relative(ROOT, f);
  return REDIRECTED_ROUTES.some((r) => rel === r || rel.startsWith(r));
};

function closure(seeds) {
  const seen = new Set();
  const st = [...seeds];
  while (st.length) {
    const f = st.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const d of importsOf.get(f) ?? []) st.push(d);
  }
  return seen;
}
const servedEntry = entry.filter((f) => !isRedirected(f));
const served = closure(servedEntry);

const reachable = new Set();
const stack = [...entry];
while (stack.length) {
  const f = stack.pop();
  if (reachable.has(f)) continue;
  reachable.add(f);
  for (const d of importsOf.get(f) ?? []) stack.push(d);
}

const rows = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const n = (src.match(LEGACY) ?? []).length + (src.match(PLAIN) ?? []).length;
  if (n) {
    rows.push({
      file: relative(ROOT, f).split(sep).join("/"),
      n,
      live: reachable.has(f),
    });
  }
}
rows.sort((a, b) => b.n - a.n);

const sum = (rs) => rs.reduce((t, r) => t + r.n, 0);
const live = rows.filter((r) => r.live);
const dead = rows.filter((r) => !r.live);

// Guard the guard: a broken walk or a broken regex both read as "all done".
if (entry.length < 20) throw new Error(`only ${entry.length} entrypoints — the walk is wrong`);
if (files.length < 200) throw new Error(`only ${files.length} files — the walk is wrong`);
if (rows.length === 0) throw new Error("zero legacy classes anywhere — the regex is wrong");

console.log(`entrypoints under app/        ${entry.length}`);
console.log(`.ts(x) files scanned          ${files.length}`);
console.log(`reachable from an entrypoint  ${reachable.size}`);
console.log("");
console.log(`legacy classes, TOTAL         ${sum(rows)}   in ${rows.length} files`);
console.log(`  ... in RENDERED files       ${sum(live)}   in ${live.length} files`);
console.log(`  ... in UNREACHABLE files    ${sum(dead)}   in ${dead.length} files`);
console.log("");
console.log("top 20 RENDERED files:");
for (const r of live.slice(0, 20)) console.log(`  ${String(r.n).padStart(4)}  ${r.file}`);
console.log("");
console.log("unreachable files with the most (do NOT count these as work):");
for (const r of dead.slice(0, 10)) console.log(`  ${String(r.n).padStart(4)}  ${r.file}`);
console.log("");
const byArea = {};
for (const r of live) {
  const area = r.file.startsWith("app/admin")
    ? "app/admin"
    : r.file.startsWith("app/dashboard")
      ? "app/dashboard"
      : r.file.startsWith("app/")
        ? "app/ (other)"
        : "components/";
  byArea[area] = (byArea[area] ?? 0) + r.n;
}
console.log("rendered legacy classes by area:");
for (const [a, n] of Object.entries(byArea).sort((x, y) => y[1] - x[1])) {
  console.log(`  ${String(n).padStart(5)}  ${a}`);
}

const inServed = live.filter((r) => served.has(join(ROOT, r.file.split("/").join(sep))));
const onlyRedirected = live.filter((r) => !served.has(join(ROOT, r.file.split("/").join(sep))));
console.log("");
console.log("SPLIT BY WHETHER A FEDERATED VISITOR CAN REACH THE SCREEN:");
console.log(`  served by DMS today        ${sum(inServed)}   in ${inServed.length} files`);
console.log(`  only via a redirected route ${sum(onlyRedirected)}   in ${onlyRedirected.length} files`);
console.log("");
console.log("top 15 files DMS ACTUALLY SERVES (this is the real worklist):");
for (const r of inServed.slice(0, 15)) console.log(`  ${String(r.n).padStart(4)}  ${r.file}`);
console.log("");
console.log("biggest files only reachable through a route that 307s to ResellerOS:");
for (const r of onlyRedirected.slice(0, 8)) console.log(`  ${String(r.n).padStart(4)}  ${r.file}`);
