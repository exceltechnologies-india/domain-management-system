/**
 * The production deploy refuses to build without NEXT_PUBLIC_RESELLEROS_URL.
 *
 * Since 24 Sep 2026 DMS has no public pages of its own (owner decision), so /,
 * the Razorpay policy pages and the old shop URLs exist ONLY as redirects to
 * ResellerOS — and with the variable unset they 404. It is a build arg, so an
 * image built without it stays wrong until it is rebuilt.
 *
 * The owner chose "local only for now": production keeps its old pages until
 * a ResellerOS address is supplied. This guard is what makes that true — the
 * next deploy cannot silently strip the pages without setting the address.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const script = readFileSync(join(process.cwd(), "scripts/deploy-cloud-run.sh"), "utf8");
const cloudbuild = readFileSync(join(process.cwd(), "cloudbuild.yaml"), "utf8");

describe("deploy-cloud-run.sh", () => {
  it("exits when the variable is empty", () => {
    expect(script).toMatch(/if \[ -z "\$\{NEXT_PUBLIC_RESELLEROS_URL:-\}" \]; then[\s\S]{0,400}?exit 1/);
  });

  it("refuses a value without a scheme, which lib/reseller-os.ts would ignore", () => {
    expect(script).toMatch(/case "\$\{NEXT_PUBLIC_RESELLEROS_URL\}" in\s+http:\/\/\*\|https:\/\/\*\) ;;/);
  });

  it("checks BEFORE building, not after", () => {
    const guard = script.indexOf('if [ -z "${NEXT_PUBLIC_RESELLEROS_URL:-}" ]');
    expect(guard).toBeGreaterThan(-1);
    // Anchored on the command lines themselves: both phrases also appear in
    // the script's header comments, above the guard.
    const dockerAt = script.search(/^[ \t]+docker build \\\r?$/m);
    const cloudAt = script.search(/^[ \t]+gcloud builds submit \\\r?$/m);
    expect(dockerAt, "docker build command not found").toBeGreaterThan(-1);
    expect(cloudAt, "gcloud builds submit command not found").toBeGreaterThan(-1);
    expect(guard).toBeLessThan(dockerAt);
    expect(guard).toBeLessThan(cloudAt);
  });

  it("passes it to BOTH build paths", () => {
    expect(script).toContain('--build-arg "NEXT_PUBLIC_RESELLEROS_URL=${NEXT_PUBLIC_RESELLEROS_URL}"');
    expect(script).toContain("_NEXT_PUBLIC_RESELLEROS_URL=${NEXT_PUBLIC_RESELLEROS_URL}");
    expect(cloudbuild).toContain("'--build-arg=NEXT_PUBLIC_RESELLEROS_URL=${_NEXT_PUBLIC_RESELLEROS_URL}'");
  });
});
