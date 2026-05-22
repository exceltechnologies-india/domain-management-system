/**
 * MongoDB Connection Utility
 * 
 * Provides a cached database connection for serverless environments (like Next.js API routes).
 * Serverless functions can be called frequently, so maintaining a cached connection prevents 
 * exhausting database connection limits and improves application performance.
 * 
 * @module lib/mongodb
 */
import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error(
    "Please define the MONGODB_URI environment variable inside .env.local"
  );
}

/**
 * Global cache object to store the Mongoose connection and promise.
 * In a Node.js global scope, this persists across hot-reloads in development.
 */
interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}
const globalWithMongoose = global as typeof global & { mongoose?: MongooseCache };
let cached: MongooseCache = globalWithMongoose.mongoose ?? { conn: null, promise: null };
if (!globalWithMongoose.mongoose) {
  globalWithMongoose.mongoose = cached;
}

/**
 * Establishes or retrieves an existing connection to the MongoDB database.
 * 
 * @returns {Promise<typeof mongoose>} A connected Mongoose instance
 * @throws {Error} If the connection fails
 */
async function connectDB() {
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    // Connection-pool sizing is tied to Cloud Run's `--concurrency` value
    // (see scripts/deploy-cloud-run.sh — currently 80). Each in-flight
    // request that touches Mongo holds one connection from the pool while
    // its query is in flight. With the previous `maxPoolSize: 10`, the
    // 11th concurrent Mongo-touching request on an instance would queue
    // behind the active 10, adding latency floor proportional to query
    // duration. Bumped to 50 — comfortably covers most realistic
    // simultaneous request fan-outs on an 80-concurrency instance,
    // headroom for short bursts without thrashing.
    //
    // Atlas cap math: 50 × max-instances (5) = 250 connections worst-case
    // against the cluster — well inside an M10's 1500-connection limit.
    //
    // If `--concurrency` is raised, raise this number too. If we ever
    // move to per-route DB pools or a connection proxy, revisit.
    const opts = {
      bufferCommands: false,
      maxPoolSize: 50,
      minPoolSize: 2,
      maxConnecting: 5, // up from the default 2 — faster pool warmup on burst
      maxIdleTimeMS: 30000,
      // Block at most 10s waiting for a free pool connection before throwing.
      // Default is infinite, which under saturation turns into invisible
      // 60s request hangs that don't surface as "Mongo is the bottleneck".
      waitQueueTimeoutMS: 10000,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    };

    cached.promise = mongoose.connect(MONGODB_URI!, opts).then((mongoose) => {
      return mongoose;
    });
  }

  try {
    cached.conn = await cached.promise;
  } catch (e) {
    cached.promise = null;
    throw e;
  }

  return cached.conn;
}

export default connectDB;
