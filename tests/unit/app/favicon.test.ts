/**
 * One icon design with ResellerOS (owner, 30 Sep 2026): the blue Anutech "A" mark. The same
 * favicon.ico is in ResellerOS's production/src/app/. This pins that DMS serves it and the
 * Apple touch icon, and that the layout points at both.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("DMS icons", () => {
  it("favicon.ico is a real multi-size .ico", () => {
    const b = readFileSync("public/favicon.ico");
    expect([b.readUInt16LE(0), b.readUInt16LE(2)]).toEqual([0, 1]);
    expect(b.readUInt16LE(4)).toBeGreaterThanOrEqual(2);
  });

  it("apple-touch-icon.png is a 180x180 PNG", () => {
    const b = readFileSync("public/apple-touch-icon.png");
    expect([...b.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([180, 180]);
  });

  it("the layout declares both", () => {
    const src = readFileSync("app/layout.tsx", "utf8");
    expect(src).toContain("icon: '/favicon.ico'");
    expect(src).toContain("apple: '/apple-touch-icon.png'");
  });
});
