/**
 * Google reCAPTCHA utilities for client and server
 */

import { logger } from "@/lib/logger";
import { serverLogger } from "@/lib/server-logger";

// Client-side: Load reCAPTCHA script and handle widget
export class RecaptchaClient {
  private static siteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY || "";
  private static scriptPromise: Promise<void> | null = null;

  /**
   * Load reCAPTCHA script
   */
  static loadScript(): Promise<void> {
    if (this.scriptPromise) {
      return this.scriptPromise;
    }

    this.scriptPromise = new Promise((resolve, reject) => {
      if (typeof window === "undefined") {
        reject(new Error("reCAPTCHA can only be loaded in browser"));
        return;
      }

      // Check if script already exists
      if (document.querySelector('script[src*="google.com/recaptcha/api.js"]')) {
        resolve();
        return;
      }

      // SRI not applied: Google does not publish stable hashes for recaptcha/api.js;
      // the script updates without versioning the URL. CSP restricts to www.google.com.
      const script = document.createElement("script");
      script.src = `https://www.google.com/recaptcha/api.js?render=explicit`;
      script.async = true;
      script.defer = true;

      script.onload = () => {
        // Wait for grecaptcha to be ready
        const checkReady = () => {
          if ((window as any).grecaptcha && (window as any).grecaptcha.render) {
            resolve();
          } else {
            setTimeout(checkReady, 100);
          }
        };
        checkReady();
      };

      script.onerror = () => {
        this.scriptPromise = null;
        reject(new Error("Failed to load Google reCAPTCHA script."));
      };

      document.head.appendChild(script);
    });

    return this.scriptPromise;
  }

  /**
   * Render reCAPTCHA widget
   */
  static async render(
    container: string | HTMLElement,
    options?: {
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      theme?: 'light' | 'dark';
      size?: 'normal' | 'compact';
    }
  ): Promise<number | null> {
    if (typeof window === "undefined") {
      throw new Error("reCAPTCHA can only be rendered in browser");
    }

    const currentSiteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY || this.siteKey;

    if (!currentSiteKey || currentSiteKey === 'your-recaptcha-site-key') {
      logger.warn("reCAPTCHA site key not configured correctly");
      return null;
    }

    await this.loadScript();

    try {
      const widgetId = (window as any).grecaptcha.render(container, {
        sitekey: currentSiteKey,
        callback: options?.callback,
        "expired-callback": options?.["expired-callback"],
        "error-callback": options?.["error-callback"],
        theme: options?.theme || "light",
        size: options?.size || "normal",
      });

      return widgetId;
    } catch (error) {
      logger.error("reCAPTCHA render error:", error);
      throw error;
    }
  }

  /**
   * Reset reCAPTCHA widget
   */
  static reset(widgetId?: number): void {
    if (typeof window === "undefined" || !(window as any).grecaptcha) {
      return;
    }

    try {
      (window as any).grecaptcha.reset(widgetId);
    } catch (error) {
      logger.error("Error resetting reCAPTCHA:", error);
    }
  }

  /**
   * Get response token from reCAPTCHA
   */
  static getResponse(widgetId?: number): string {
    if (typeof window === "undefined" || !(window as any).grecaptcha) {
      return "";
    }
    return (window as any).grecaptcha.getResponse(widgetId);
  }
}

// Server-side: Verify reCAPTCHA token
export class RecaptchaServer {
  private static secretKey = process.env.RECAPTCHA_SECRET_KEY || "";
  private static verifyUrl = "https://www.google.com/recaptcha/api/siteverify";

  /**
   * Check if captcha is enabled via the DB setting.
   * Defaults to true on any error so security is never silently degraded.
   */
  static async isCaptchaEnabled(): Promise<boolean> {
    try {
      const { SettingsService } = await import("@/lib/settings-service");
      const value = await SettingsService.getSetting("captcha_enabled", true);
      return value === true || value === "true";
    } catch {
      return true;
    }
  }

  /**
   * Verify reCAPTCHA token
   */
  static async verifyToken(
    token: string,
    remoteip?: string
  ): Promise<{
    success: boolean;
    error?: string;
    "error-codes"?: string[];
  }> {
    // Honour the admin-controlled kill-switch before anything else
    const captchaEnabled = await this.isCaptchaEnabled();
    if (!captchaEnabled) {
      return { success: true };
    }

    if (!this.secretKey || this.secretKey === 'your-recaptcha-secret-key') {
      serverLogger.warn("reCAPTCHA secret key not configured - skipping verification");
      return { success: true };
    }

    if (!token || token === 'captcha-disabled') {
      return {
        success: false,
        error: "reCAPTCHA token is required",
      };
    }

    try {
      const params = new URLSearchParams();
      params.append("secret", this.secretKey);
      params.append("response", token);
      if (remoteip) {
        params.append("remoteip", remoteip);
      }

      const response = await fetch(this.verifyUrl, {
        method: "POST",
        body: params,
      });

      const data = await response.json();

      if (!data.success) {
        return {
          success: false,
          error: "reCAPTCHA verification failed",
          "error-codes": data["error-codes"] || [],
        };
      }

      return { success: true };
    } catch (error) {
      serverLogger.error("reCAPTCHA verification error:", error);
      return {
        success: false,
        error: "Failed to verify reCAPTCHA",
      };
    }
  }
}
