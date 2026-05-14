import connectDB from "./mongodb";

/**
 * Connect to the database
 * This is a wrapper around the connectDB function from mongodb.ts
 * to maintain compatibility with existing code that expects connectToDatabase
 */
export async function connectToDatabase() {
  return await connectDB();
}
