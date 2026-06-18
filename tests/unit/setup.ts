// Default MONGODB_URI so module-load-time env checks in lib/mongodb.ts don't
// throw when a test transitively imports something that pulls it in (e.g.
// lib/services/payment/order-creator → lib/services/payments → lib/mongodb).
// The mongoose mock below stubs `connect` away, so the placeholder URI is
// never actually dialed.
process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://placeholder";

import { vi } from "vitest";
// Register @testing-library/jest-dom matchers (toBeInTheDocument, etc.) for
// component tests. Harmless for the existing model/service/store unit suites.
import "@testing-library/jest-dom/vitest";

// Stub Next.js server-only modules that aren't available in jsdom
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn(),
    next: vi.fn(),
    redirect: vi.fn(),
  },
}));

// Stub mongoose so model imports don't attempt DB connections in unit tests
vi.mock("mongoose", async () => {
  const actual = await vi.importActual<typeof import("mongoose")>("mongoose");
  return {
    ...actual,
    connect: vi.fn(),
    model: vi.fn(() => ({})),
    models: {},
  };
});
