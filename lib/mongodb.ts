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
let cached = (global as any).mongoose;

if (!cached) {
  cached = (global as any).mongoose = { conn: null, promise: null };
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
    const opts = {
      bufferCommands: false,
      maxPoolSize: 10, // Maximum 10 connections in the pool
      minPoolSize: 2, // Minimum 2 connections maintained
      maxIdleTimeMS: 30000, // Close idle connections after 30 seconds
      serverSelectionTimeoutMS: 5000, // 5 second timeout for server selection
      socketTimeoutMS: 45000, // 45 second timeout for socket operations
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
