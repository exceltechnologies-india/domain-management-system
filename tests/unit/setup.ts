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
