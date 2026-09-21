/**
 * A SOURCE SCAN, because the bug it exists for was invisible to every unit
 * test in this folder.
 *
 * Phase 1 built `classifyTransport`, Phase 2 built a claim that is held when a
 * write may have landed, and Phase 4's route threw both away in one line:
 *
 *     transport: "not_sent"   // "no handler here contacts anything yet"
 *
 * True when written. Phase 6 shipped three handlers that DO contact providers
 * and the comment did not change, so a DNS write that died mid-flight was
 * recorded as never sent and its subject was released. Nothing went red —
 * every engine test asks whether a DECISION is right, and this was wiring.
 * AGENTS.md L85: when a suite tests decisions well, the remaining risk moves
 * to the wiring, so put the scans there.
 *
 * Two things are asserted, and both are about the source text rather than
 * behaviour, because behaviour is what the other files already cover:
 *
 *  1. The route READS the transport off the error instead of assuming it, and
 *     maps `sent_unknown` to `needs_reconciliation` — the one status that does
 *     not release the claim.
 *  2. Every provider WRITE in a handler goes through `attemptProviderWrite`.
 *     One that does not is branded nothing, reads as `not_sent`, and frees a
 *     subject that may have been changed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROUTE = "app/api/integrations/engine/commands/route.ts";
const HANDLER_DIR = "lib/integrations";

/**
 * Comments are stripped before asserting, for the reason `sentry-client.test.ts`
 * in the sibling repo gives: a blunt scan over raw text punishes documentation,
 * and the reasoning gets deleted to satisfy the test (AGENTS.md L46). The
 * prose in these files names every function below.
 */
function codeOf(relPath: string): string {
  const raw = readFileSync(join(process.cwd(), relPath), "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the command route classifies instead of assuming", () => {
  const code = codeOf(ROUTE);

  it("scanned a real file", () => {
    // Guard the guard: a typo'd path would make every assertion below vacuous.
    expect(code.length).toBeGreaterThan(500);
    expect(code).toContain("completeCommand");
  });

  it("reads the transport off the thrown error", () => {
    expect(code).toMatch(/transportOf\(\s*err\s*\)/);
  });

  it("does not hardcode not_sent on completion any more", () => {
    // The exact line that caused it. `?? "not_sent"` as a default for an
    // UNBRANDED error is correct and is a different shape.
    expect(code).not.toMatch(/transport:\s*"not_sent"/);
  });

  it("maps sent_unknown to needs_reconciliation, the status that HOLDS the claim", () => {
    expect(code).toMatch(/sent_unknown"\s*\?\s*"needs_reconciliation"/);
  });

  it("does not tell the caller nothing changed when it does not know", () => {
    // The old message said "Nothing was changed" on every failure. For a write
    // that may have landed that is the most expensive sentence available.
    const nothingChanged = code.match(/Nothing was changed/g) ?? [];
    expect(nothingChanged.length).toBe(1);
    expect(code).toMatch(/did not learn what it did/);
  });
});

describe("every provider WRITE in a handler is wrapped", () => {
  /**
   * The calls that can change something at the far end. Reads are deliberately
   * absent: a read that fails changed nothing, and wrapping one would hold a
   * subject for a human with nothing to decide.
   */
  const WRITES = [
    "suspendUser(",
    "unsuspendUser(",
    "changePackage(",
    "addDNSRecord(",
    "updateDNSRecord(",
  ];

  const handlerFiles = readdirSync(join(process.cwd(), HANDLER_DIR)).filter(
    (f) => f.startsWith("engine-handlers-") && f.endsWith(".ts")
  );

  it("found the handler files", () => {
    // If a rename makes this list empty the suite must fail, not pass quietly.
    expect(handlerFiles.length).toBeGreaterThanOrEqual(3);
  });

  it.each(handlerFiles)("%s wraps each write it performs", (file) => {
    const code = codeOf(join(HANDLER_DIR, file));
    for (const write of WRITES) {
      let from = 0;
      for (;;) {
        const at = code.indexOf(write, from);
        if (at === -1) break;
        from = at + write.length;
        // The import line is not a call site.
        const line = code.slice(code.lastIndexOf("\n", at) + 1, at + write.length);
        if (line.includes("import")) continue;
        const before = code.slice(Math.max(0, at - 90), at);
        expect(
          before.includes("attemptProviderWrite"),
          `${file}: ${write} is called without attemptProviderWrite — a failure mid-flight ` +
            "would be recorded as never sent and the subject released"
        ).toBe(true);
      }
    }
  });
});
