import { describe, it, expect } from "vitest";
import { extractTrackingId, hasAnyTag } from "@/lib/services/tracking";
import type { TrackingConfig } from "@/lib/services/tracking";

describe("extractTrackingId — pulls the canonical ID out of a pasted snippet", () => {
  describe("GA4 (G-…)", () => {
    it("extracts from the official gtag.js snippet", () => {
      const raw = `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-ABC123XYZ');
</script>`;
      expect(extractTrackingId("ga4", raw)).toBe("G-ABC123XYZ");
    });
    it("accepts a bare ID and uppercases it", () => {
      expect(extractTrackingId("ga4", "g-abc123")).toBe("G-ABC123");
    });
    it("returns '' when no GA4 id present", () => {
      expect(extractTrackingId("ga4", "GTM-XXXX just a container")).toBe("");
    });
  });

  describe("GTM (GTM-…)", () => {
    it("extracts from the GTM head snippet", () => {
      const raw = `(function(w,d,s,l,i){...})(window,document,'script','dataLayer','GTM-ABCD12');`;
      expect(extractTrackingId("gtm", raw)).toBe("GTM-ABCD12");
    });
    it("does NOT match a GA4 id", () => {
      expect(extractTrackingId("gtm", "G-ABC123")).toBe("");
    });
  });

  describe("Meta Pixel (numeric)", () => {
    it("extracts the id from fbq('init', …) even when other numbers are present", () => {
      const raw = `!function(f,b,e,v,n,t,s){...n.version='2.0';...}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '1234567890123456');
fbq('track', 'PageView');`;
      expect(extractTrackingId("meta", raw)).toBe("1234567890123456");
    });
    it("accepts a bare numeric id", () => {
      expect(extractTrackingId("meta", "  987654321  ")).toBe("987654321");
    });
    it("returns '' for a non-numeric blob with no fbq init", () => {
      expect(extractTrackingId("meta", "version 2.0 released")).toBe("");
    });
  });

  describe("Google Ads (AW-…)", () => {
    it("extracts from a gtag Ads snippet", () => {
      const raw = `<script async src="https://www.googletagmanager.com/gtag/js?id=AW-123456789"></script>`;
      expect(extractTrackingId("googleAds", raw)).toBe("AW-123456789");
    });
  });

  describe("security boundary", () => {
    it("returns '' (never the payload) for arbitrary markup", () => {
      expect(extractTrackingId("ga4", "<img src=x onerror=alert(1)>")).toBe("");
      expect(extractTrackingId("meta", "<script>steal()</script>")).toBe("");
      expect(extractTrackingId("gtm", "")).toBe("");
    });
    it("only ever returns a string matching the strict provider shape", () => {
      const out = extractTrackingId("ga4", "prefix G-GOOD1 <script>evil</script> suffix");
      expect(out).toBe("G-GOOD1");
      expect(out).not.toContain("<");
    });
  });
});

describe("hasAnyTag", () => {
  const base: TrackingConfig = {
    enabled: false, ga4Id: "", gtmId: "", metaPixelId: "", googleAdsId: "", loadOnAdmin: false, spaPageViews: true,
  };
  it("false when disabled even with an id", () => {
    expect(hasAnyTag({ ...base, ga4Id: "G-X" })).toBe(false);
  });
  it("false when enabled but no id", () => {
    expect(hasAnyTag({ ...base, enabled: true })).toBe(false);
  });
  it("true when enabled and at least one id", () => {
    expect(hasAnyTag({ ...base, enabled: true, metaPixelId: "123456" })).toBe(true);
  });
});
