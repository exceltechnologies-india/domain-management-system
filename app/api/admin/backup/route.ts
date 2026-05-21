import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import { verifyAdminAuth } from "@/lib/admin-auth";
import { getUserWithPassword } from "@/lib/services/users";
import mongoose from "mongoose";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { serverLogger } from "@/lib/server-logger";
import { logAdminAction } from "@/lib/audit-log";

// Fields that must never appear in backup exports.
// Keys are MongoDB collection names (lowercase-plural Mongoose default).
const SENSITIVE_PROJECTIONS: Record<string, Record<string, 0>> = {
  users: {
    password: 0,
    totpSecret: 0,
    totpSecretPending: 0,
    totpBackupCodes: 0,
    resetToken: 0,
    resetTokenExpiry: 0,
    pendingEmailToken: 0,
  },
  orders: {
    razorpaySignature: 0,
  },
};

export const dynamic = 'force-dynamic'; // Prevent static caching
export const maxDuration = 300; // Allow 5 minutes for backup

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID();
  serverLogger.info(`[Backup] Initiation attempt. RequestId: ${requestId}`);

  try {
    // 1. Verify Admin Auth
    const authResult = await verifyAdminAuth(request);
    if (!authResult.valid || !authResult.user) {
      serverLogger.warn(`[Backup] Auth failed. RequestId: ${requestId}. Error: ${authResult.error}`);
      return NextResponse.json(
        { error: authResult.error },
        { status: 401 }
      );
    }
    const adminAuthUser = authResult.user;
    serverLogger.info(`[Backup] Admin authenticated. User: ${adminAuthUser.id}, RequestId: ${requestId}`);

    // 2. Parse Body for Password
    let body;
    try {
      body = await request.json();
    } catch (e) {
      serverLogger.warn(`[Backup] Invalid JSON body. RequestId: ${requestId}`);
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }

    const { password } = body;
    if (!password) {
      serverLogger.warn(`[Backup] Missing password. RequestId: ${requestId}`);
      return NextResponse.json(
        { error: "Password is required" },
        { status: 400 }
      );
    }

    // 3. Verify Password
    // Refetch with +password explicitly (the field is select:false on the
    // model so the default reader doesn't carry it).
    const adminUser = await getUserWithPassword(adminAuthUser.id);

    if (!adminUser) {
      serverLogger.error(`[Backup] User not found during re-verification. ID: ${adminAuthUser.id}`);
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const isPasswordValid = await adminUser.comparePassword(password);
    if (!isPasswordValid) {
      serverLogger.warn(`[Backup] Invalid password provided. User: ${adminAuthUser.email}`);
      return NextResponse.json(
        { error: "Invalid password. Access denied." },
        { status: 403 }
      );
    }

    serverLogger.info(`[Backup] Password verified. Starting backup stream. RequestId: ${requestId}`);

    // Immutable audit trail entry — recorded before the stream begins
    const clientIp =
      request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";
    await logAdminAction({
      userId: adminAuthUser.id,
      userEmail: adminAuthUser.email,
      action: "DATABASE_BACKUP_DOWNLOAD",
      resource: "/api/admin/backup",
      method: "POST",
      path: "/api/admin/backup",
      ip: clientIp,
      success: true,
      metadata: { requestId },
    });

    // 4. Streaming Backup Logic
    if (!mongoose.connection.db) {
      serverLogger.error(`[Backup] Database connection missing. RequestId: ${requestId}`);
      throw new Error("Database connection not established");
    }

    // Generator function that yields chunks of the JSON
    // Structure: { "timestamp": "...", "collections": { "col1": [...], "col2": [...] } }
    const jsonStreamGenerator = async function* () {
      yield `{\n  "timestamp": "${new Date().toISOString()}",\n  "collections": {\n`;

      const collections = await mongoose.connection.db!.listCollections().toArray();
      let firstCollection = true;

      for (const collection of collections) {
        const collectionName = collection.name;
        // Skip system collections
        if (collectionName.startsWith("system.")) continue;

        if (!firstCollection) {
          yield `,\n`;
        }
        firstCollection = false;

        yield `    "${collectionName}": [`;

        const projection = SENSITIVE_PROJECTIONS[collectionName] ?? {};
        const cursor = mongoose.connection.db!
          .collection(collectionName)
          .find({}, Object.keys(projection).length > 0 ? { projection } : {});
        let firstDoc = true;

        for await (const doc of cursor) {
          if (!firstDoc) {
            yield `,`;
          }
          firstDoc = false;
          try {
            yield JSON.stringify(doc);
          } catch (serializeError) {
             serverLogger.error(`[Backup] Failed to serialize document in ${collectionName}. Skipping. Error:`, serializeError);
          }
        }

        yield `]`;
      }

      yield `\n  }\n}`;
      serverLogger.info(`[Backup] Stream generation completed. RequestId: ${requestId}`);
    }

    // Create Readable stream from generator
    const jsonStream = Readable.from(jsonStreamGenerator());

    // Create Gzip transform stream
    const gzip = zlib.createGzip();

    // Pipe JSON -> Gzip
    const compressedStream = jsonStream.pipe(gzip);

    // Return the response stream
    // "duplex": "half" is required for Node streams in Next.js App Router in some versions, 
    // but wrapping in `new Response` usually handles it if we pass the stream directly.
    // However, `NextResponse` expects standard Web Streams or Node Streams. 
    // Typescript might complain about Node streams not exactly matching Web ReadableStream.
    // We can use `iteratorToStream` if needed, but `Readable.toWeb` is cleaner if available in this Node version.
    // Given the environment, let's try passing the Node stream directly as it often works in Next.js 14, 
    // or convert it to a Web Stream using `Readable.toWeb` if supported (Node 17+).
    // Safest fallback for Typescript/Next is creating a Web ReadableStream that pulls from the Node stream.
    
    // Note: Node.js 18+ supports `Readable.toWeb`.
    // Let's assume a modern environment. If not, we can implement a simple adapter.
    
    // Helper to convert Node stream to Web stream
    const webStream = new ReadableStream({
        start(controller) {
            compressedStream.on('data', (chunk) => controller.enqueue(chunk));
            compressedStream.on('end', () => controller.close());
            compressedStream.on('error', (err) => {
                serverLogger.error(`[Backup] Stream error. RequestId: ${requestId}`, err);
                controller.error(err);
            });
        }
    });

    return new Response(webStream, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="backup-${new Date()
          .toISOString()
          .replace(/[:.]/g, "-")}.json.gz"`,
      },
    });

  } catch (error: unknown) {
    serverLogger.error("Backup error:", error);
    return NextResponse.json(
      { error: "Internal server error during backup" },
      { status: 500 }
    );
  }
}
