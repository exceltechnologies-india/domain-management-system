/**
 * Component tests for the `components/DomainSearch` re-export shim
 * (rescan-4 M14). The actual implementation lives at
 * `components/domain-search/DomainSearch` — this 4-line module exists
 * for backwards compat so existing `import "@/components/DomainSearch"`
 * call sites keep working.
 */
import { describe, it, expect } from "vitest";
import DomainSearch from "@/components/DomainSearch";
import RealDomainSearch from "@/components/domain-search/DomainSearch";

describe("components/DomainSearch (barrel)", () => {
  it("re-exports the same default export as the refactored module", () => {
    expect(typeof DomainSearch).toBe("function");
    expect(DomainSearch).toBe(RealDomainSearch);
  });
});
