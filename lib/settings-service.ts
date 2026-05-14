import Settings from "@/models/Settings";
import { connectToDatabase } from "@/lib/mongoose";
import { serverLogger } from "@/lib/server-logger";

export class SettingsService {
  // Caching removed - always fetch fresh data

  /**
   * Get a setting value
   */
  static async getSetting(key: string, defaultValue: any = null): Promise<any> {
    try {
      // Fetch from database directly (no caching)
      await connectToDatabase();
      const setting = await Settings.findOne({ key });
      const value = setting ? setting.value : defaultValue;

      return value;
    } catch (error) {
      serverLogger.error(`Error fetching setting ${key}:`, error);
      return defaultValue;
    }
  }

  /**
   * Set a setting value
   */
  static async setSetting(
    key: string,
    value: any,
    description: string = "",
    category: string = "general",
    updatedBy: string = "system"
  ): Promise<void> {
    try {
      await connectToDatabase();

      await Settings.findOneAndUpdate(
        { key },
        {
          key,
          value,
          description,
          category,
          updatedAt: new Date(),
          updatedBy,
        },
        { upsert: true }
      );

      // No cache to clear

      serverLogger.info(
        `✅ [SETTINGS] Updated setting ${key} = ${value} by ${updatedBy}`
      );
    } catch (error) {
      serverLogger.error(`Error setting ${key}:`, error);
      throw error;
    }
  }

  /**
   * Clear all cached settings (no-op since caching is disabled)
   */
  static clearCache(): void {
    // No caching - nothing to clear
    serverLogger.info(`💰 [SETTINGS] Cache clear requested (no caching enabled)`);
  }

  /**
   * Get all settings for admin panel
   */
  static async getAllSettings(): Promise<any[]> {
    try {
      await connectToDatabase();
      const settings = await Settings.find({}).sort({ category: 1, key: 1 });
      return settings.map((setting) => ({
        key: setting.key,
        value: setting.value,
        description: setting.description,
        category: setting.category,
        updatedAt: setting.updatedAt,
        updatedBy: setting.updatedBy,
      }));
    } catch (error) {
      serverLogger.error("Error fetching all settings:", error);
      return [];
    }
  }
}
