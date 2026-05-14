import { NextRequest } from "next/server";

export class TimeService {
  /**
   * Returns the current date, potentially overridden by a simulation header or parameter.
   * Simulation is only active if ENABLE_TIME_SIMULATION=true or NODE_ENV !== 'production'.
   */
  static now(request?: NextRequest | Request | null, simulatedTimeOverride?: string | Date): Date {
    // 1. Explicit override from parameter (highest priority)
    if (simulatedTimeOverride) {
      return new Date(simulatedTimeOverride);
    }

    // 2. Check if simulation is allowed
    const isSimulationEnabled = 
      process.env.ENABLE_TIME_SIMULATION === "true" || 
      process.env.NODE_ENV !== "production";

    if (!isSimulationEnabled) {
      return new Date();
    }

    // 3. Check for header (useful for scheduler and manual triggers)
    if (request) {
      const headerTime = request.headers.get("x-simulated-time");
      if (headerTime) {
        return new Date(headerTime);
      }
    }

    // 4. Check for environment variable (global override for development)
    if (process.env.SIMULATED_TIME) {
      return new Date(process.env.SIMULATED_TIME);
    }

    return new Date();
  }

  /**
   * Returns the difference in whole days between two dates.
   */
  static daysUntil(expiryDate: Date, now: Date): number {
    const msPerDay = 1000 * 60 * 60 * 24;
    // Use floor to get whole days remaining. 
    // Positive = future, 0 = today, Negative = past
    return Math.floor((expiryDate.getTime() - now.getTime()) / msPerDay);
  }
}
