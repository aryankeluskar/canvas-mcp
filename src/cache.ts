/**
 * Caching system for Canvas and Gradescope API responses
 * Compatible with Cloudflare Workers runtime
 */

interface CacheEntry<T> {
  value: T;
  timestamp: number;
  ttl: number;
}

interface CacheConfig {
  courses: number;
  modules: number;
  module_items: number;
  file_urls: number;
  assignments: number;
  gradescope_courses: number;
  gradescope_assignments: number;
  gradescope_submissions: number;
}

// Cache TTL configuration in seconds
const CACHE_TTL: CacheConfig = {
  courses: 3600, // 1 hour
  modules: 1800, // 30 minutes
  module_items: 1800, // 30 minutes
  file_urls: 3600, // 1 hour
  assignments: 1800, // 30 minutes
  gradescope_courses: 3600, // 1 hour
  gradescope_assignments: 1800, // 30 minutes
  gradescope_submissions: 1800, // 30 minutes
};

/**
 * In-memory cache for Workers
 * Note: This cache is per-isolate and will be cleared on worker restart
 * For persistent caching, use KV namespace
 */
export class WorkerCache {
  private storage: Map<string, CacheEntry<any>> = new Map();

  /**
   * Get an item from cache if it exists and is not expired
   */
  get<T>(cacheType: keyof CacheConfig, key?: string): T | null {
    const cacheKey = key ? `${cacheType}_${key}` : cacheType;
    const entry = this.storage.get(cacheKey);

    if (!entry) {
      return null;
    }

    const currentTime = Date.now() / 1000; // Convert to seconds
    if (currentTime - entry.timestamp > entry.ttl) {
      // Entry has expired, remove it
      this.storage.delete(cacheKey);
      return null;
    }

    return entry.value;
  }

  /**
   * Store an item in cache with current timestamp
   */
  set<T>(cacheType: keyof CacheConfig, value: T, key?: string): void {
    const cacheKey = key ? `${cacheType}_${key}` : cacheType;
    const ttl = CACHE_TTL[cacheType];
    const timestamp = Date.now() / 1000; // Convert to seconds

    this.storage.set(cacheKey, {
      value,
      timestamp,
      ttl,
    });
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.storage.clear();
  }

  /**
   * Clear specific cache type
   */
  clearType(cacheType: keyof CacheConfig): void {
    const keysToDelete: string[] = [];

    for (const key of this.storage.keys()) {
      if (key.startsWith(cacheType)) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach((key) => this.storage.delete(key));
  }

  /**
   * Get cache statistics for debugging
   */
  getStats(): { totalEntries: number; cacheTypes: Record<string, number> } {
    const cacheTypes: Record<string, number> = {};

    for (const key of this.storage.keys()) {
      const type = key.split("_")[0];
      cacheTypes[type] = (cacheTypes[type] || 0) + 1;
    }

    return {
      totalEntries: this.storage.size,
      cacheTypes,
    };
  }
}

// Legacy export for backwards compatibility with old code
export const cache = new WorkerCache();
export type { CacheConfig };
