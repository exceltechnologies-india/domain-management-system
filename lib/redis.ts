import Redis from 'ioredis'
import { serverLogger } from '@/lib/server-logger'

const REDIS_HOST = process.env.REDIS_HOST || ''
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10)

if (!REDIS_HOST) {
  serverLogger.warn('⚠️ REDIS_HOST is not defined. Redis caching will be disabled.')
}

// Google Cloud Memorystore connection (standard Redis TCP protocol).
// Typed as `Redis | null` so callers must narrow before use — the previous
// `null as unknown as Redis` cast made every untyped `redis.foo()` a
// runtime NPE waiting to happen.
export const redis: Redis | null = REDIS_HOST
  ? new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      commandTimeout: 3000,
    })
  : null

if (redis) {
  redis.on('error', (err: Error) => {
    serverLogger.error('Redis connection error:', err.message)
  })
  redis.on('connect', () => {
    serverLogger.info('Connected to Google Cloud Memorystore')
  })
}

export const redisCache = {
  async get<T>(key: string): Promise<T | null> {
    if (!redis) return null
    try {
      const value = await redis.get(key)
      if (value === null) return null
      return JSON.parse(value) as T
    } catch (error) {
      serverLogger.error(`❌ Redis Get Error [${key}]:`, error)
      return null
    }
  },

  async set(key: string, value: unknown, ttlSeconds: number = 120): Promise<void> {
    if (!redis) return
    try {
      await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds)
    } catch (error) {
      serverLogger.error(`❌ Redis Set Error [${key}]:`, error)
    }
  },

  async del(key: string): Promise<void> {
    if (!redis) return
    try {
      await redis.del(key)
    } catch (error) {
      serverLogger.error(`❌ Redis Del Error [${key}]:`, error)
    }
  },
}
