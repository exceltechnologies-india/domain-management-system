/**
 * Safe storage utility to handle "Access to storage is not allowed" errors
 * This often happens in privacy modes or when cookies/storage are blocked
 */

import { logger } from "@/lib/logger";

type StorageType = 'localStorage' | 'sessionStorage';

class MemoryStorage implements Storage {
  private data: Map<string, string>;

  constructor() {
    this.data = new Map<string, string>();
  }

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) || null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] || null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

class SafeStorage implements Storage {
  private storage: Storage;
  private readonly storageType: StorageType;

  constructor(type: StorageType) {
    this.storageType = type;
    this.storage = this.getStorage();
  }

  private getStorage(): Storage {
    try {
      if (typeof window !== 'undefined' && window[this.storageType]) {
        // Test storage access to ensure it really works
        const testKey = `__${this.storageType}_test__`;
        window[this.storageType].setItem(testKey, testKey);
        window[this.storageType].removeItem(testKey);
        return window[this.storageType];
      }
    } catch (e) {
      logger.warn(`Access to ${this.storageType} is blocked, falling back to in-memory storage`);
    }
    return new MemoryStorage();
  }

  get length(): number {
    return this.storage.length;
  }

  clear(): void {
    this.storage.clear();
  }

  getItem(key: string): string | null {
    return this.storage.getItem(key);
  }

  key(index: number): string | null {
    return this.storage.key(index);
  }

  removeItem(key: string): void {
    this.storage.removeItem(key);
  }

  setItem(key: string, value: string): void {
    try {
      this.storage.setItem(key, value);
    } catch (e) {
      logger.warn(`Failed to set item in ${this.storageType} even with fallback:`, e);
    }
  }
}

export const safeLocalStorage = new SafeStorage('localStorage');
export const safeSessionStorage = new SafeStorage('sessionStorage');
