import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Redis so tests never hit a real network
vi.mock("@/lib/redis", () => ({
  redisCache: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock axios before importing the service
vi.mock("axios", async () => {
  const actual = await vi.importActual<typeof import("axios")>("axios");
  return {
    ...actual,
    default: {
      ...actual.default,
      create: vi.fn(() => ({
        get: vi.fn(),
        interceptors: { request: { use: vi.fn() } },
      })),
    },
  };
});

// Mock SettingsService to avoid DB imports inside pricing-service
vi.mock("@/lib/settings-service", () => ({
  SettingsService: {
    getSetting: vi.fn().mockResolvedValue(null),
  },
}));

describe("PricingService caching", () => {
  beforeEach(() => {
    // Set required env vars BEFORE dynamically importing the module.
    // pricing-service.ts throws at module level when these are missing.
    vi.stubEnv("RESELLERCLUB_API_URL", "https://test-api.resellerclub.example.com");
    vi.stubEnv("RESELLERCLUB_ID", "test-reseller-id");
    vi.stubEnv("RESELLERCLUB_SECRET", "test-reseller-secret");

    vi.clearAllMocks();
    // Reset module so cached transporter / in-flight dedupe state is fresh
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns cached data when Redis has a hit", async () => {
    const { redisCache } = await import("@/lib/redis");
    const cached = {
      customerPricing: { com: { addnewdomain: { "1": "1000" } } },
      resellerPricing: {},
      timestamp: new Date().toISOString(),
    };
    vi.mocked(redisCache.get).mockResolvedValueOnce(cached);

    const { PricingService } = await import("@/lib/pricing-service");
    const result = await PricingService.getDomainPricing();

    expect(result).toEqual(cached);
    expect(redisCache.set).not.toHaveBeenCalled();
  });

  it("fetches from API and populates cache on miss", async () => {
    const { redisCache } = await import("@/lib/redis");
    vi.mocked(redisCache.get).mockResolvedValue(null);

    const axios = await import("axios");
    const mockGet = vi.fn()
      .mockResolvedValueOnce({ data: { com: {} } })   // customer pricing
      .mockResolvedValueOnce({ data: { com: {} } });   // reseller pricing
    vi.mocked(axios.default.create).mockReturnValue({
      get: mockGet,
      interceptors: { request: { use: vi.fn() } },
    } as any);

    const { PricingService } = await import("@/lib/pricing-service");
    await PricingService.getDomainPricing();

    expect(redisCache.set).toHaveBeenCalledTimes(2); // live + stale key
  });
});
