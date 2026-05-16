/**
 * @deprecated Class-style shim that delegates to `lib/services/settings.ts`.
 *
 * Kept only so the few remaining `SettingsService.getSetting(...)` call sites
 * keep compiling. New code should import the functional API directly:
 *   import { getSettingValue, upsertSetting } from "@/lib/services/settings";
 */

import {
  getSettingValue,
  listSettings,
  upsertSetting,
} from "./services/settings";
import { serverLogger } from "./server-logger";

export class SettingsService {
  static async getSetting<T = unknown>(
    key: string,
    defaultValue: T | null = null
  ): Promise<T | null> {
    return getSettingValue<T>(key, defaultValue);
  }

  static async setSetting(
    key: string,
    value: unknown,
    description: string = "",
    category: string = "general",
    updatedBy: string = "system"
  ): Promise<void> {
    return upsertSetting(key, value, { description, category, updatedBy });
  }

  /** No-op since settings reads are uncached. */
  static clearCache(): void {
    serverLogger.info(`💰 [SETTINGS] Cache clear requested (no caching enabled)`);
  }

  static async getAllSettings(): Promise<
    Array<{
      key: string;
      value: unknown;
      description?: string;
      category?: string;
      updatedAt?: Date;
      updatedBy?: string;
    }>
  > {
    const docs = await listSettings();
    return docs.map((d) => ({
      key: d.key,
      value: d.value,
      description: d.description,
      category: d.category,
      updatedAt: d.updatedAt,
      updatedBy: d.updatedBy,
    }));
  }
}
