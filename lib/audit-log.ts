/**
 * Audit Logging System
 * Logs all admin actions for security and compliance
 */

import { NextRequest } from "next/server";
import connectDB from "@/lib/mongodb";
import { serverLogger } from "@/lib/server-logger";
import mongoose from "mongoose";

// Audit Log Schema
const AuditLogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    userEmail: {
      type: String,
      required: true,
      index: true,
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    resource: {
      type: String,
      required: true,
    },
    method: {
      type: String,
      required: true,
    },
    path: {
      type: String,
      required: true,
    },
    ip: {
      type: String,
      required: true,
      index: true,
    },
    userAgent: {
      type: String,
    },
    requestBody: {
      type: mongoose.Schema.Types.Mixed,
    },
    responseStatus: {
      type: Number,
    },
    executionTime: {
      type: Number, // milliseconds
    },
    success: {
      type: Boolean,
      default: true,
      index: true,
    },
    error: {
      type: String,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

// Create indexes for better query performance
AuditLogSchema.index({ userId: 1, createdAt: -1 });
AuditLogSchema.index({ action: 1, createdAt: -1 });
AuditLogSchema.index({ ip: 1, createdAt: -1 });
AuditLogSchema.index({ createdAt: -1 }); // For cleanup queries

// TTL index - automatically delete logs older than 90 days
AuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 }); // 90 days

const AuditLog =
  mongoose.models.AuditLog ||
  mongoose.model("AuditLog", AuditLogSchema);

export interface AuditLogEntry {
  userId: string;
  userEmail: string;
  action: string;
  resource: string;
  method: string;
  path: string;
  ip: string;
  userAgent?: string;
  requestBody?: any;
  responseStatus?: number;
  executionTime?: number;
  success?: boolean;
  error?: string;
  metadata?: any;
}

/**
 * Log an admin action
 */
export async function logAdminAction(entry: AuditLogEntry): Promise<void> {
  try {
    await connectDB();
    await AuditLog.create(entry);
  } catch (error) {
    serverLogger.error("Error logging admin action:", error);
    // Don't throw - logging failures shouldn't break the application
  }
}

/**
 * Log API request
 */
export async function logAPIRequest(
  request: NextRequest,
  user: any,
  responseStatus: number,
  executionTime: number,
  error?: string
): Promise<void> {
  try {
    const clientIP = getClientIP(request);
    const userAgent = request.headers.get("user-agent") || "";

    // Sanitize request body (remove sensitive data)
    let requestBody: any = null;
    try {
      const clonedRequest = request.clone();
      const body = await clonedRequest.json().catch(() => null);
      if (body) {
        requestBody = sanitizeRequestBody(body);
      }
    } catch (e) {
      // Request body already consumed or not available
    }

    await logAdminAction({
      userId: user.id || user._id?.toString() || "unknown",
      userEmail: user.email || "unknown",
      action: getActionFromPath(request.nextUrl.pathname, request.method),
      resource: request.nextUrl.pathname,
      method: request.method,
      path: request.nextUrl.pathname,
      ip: clientIP,
      userAgent,
      requestBody,
      responseStatus,
      executionTime,
      success: responseStatus < 400,
      error: error || (responseStatus >= 400 ? `HTTP ${responseStatus}` : undefined),
      metadata: {
        query: Object.fromEntries(request.nextUrl.searchParams),
      },
    });
  } catch (error) {
    serverLogger.error("Error logging API request:", error);
  }
}

/**
 * Get action name from path and method
 */
function getActionFromPath(path: string, method: string): string {
  const pathParts = path.split("/").filter(Boolean);
  const resource = pathParts[pathParts.length - 1] || "unknown";

  const actionMap: Record<string, string> = {
    GET: "VIEW",
    POST: "CREATE",
    PUT: "UPDATE",
    PATCH: "UPDATE",
    DELETE: "DELETE",
  };

  return `${actionMap[method] || method}_${resource.toUpperCase()}`;
}

/**
 * Sanitize request body to remove sensitive information
 */
function sanitizeRequestBody(body: any): any {
  if (!body || typeof body !== "object") {
    return body;
  }

  const sensitiveFields = [
    "password",
    "token",
    "secret",
    "apiKey",
    "accessToken",
    "refreshToken",
    "creditCard",
    "cvv",
    "ssn",
  ];

  const sanitized = { ...body };

  for (const field of sensitiveFields) {
    if (sanitized[field]) {
      sanitized[field] = "[REDACTED]";
    }
  }

  return sanitized;
}

/**
 * Get client IP from request
 */
function getClientIP(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const realIP = request.headers.get("x-real-ip");
  const ip = (request as any).ip;

  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  return realIP || ip || "unknown";
}

/**
 * Query audit logs
 */
export async function queryAuditLogs(filters: {
  userId?: string;
  action?: string;
  ip?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  skip?: number;
}): Promise<any[]> {
  try {
    await connectDB();

    const query: any = {};

    if (filters.userId) {
      query.userId = new mongoose.Types.ObjectId(filters.userId);
    }

    if (filters.action) {
      query.action = filters.action;
    }

    if (filters.ip) {
      query.ip = filters.ip;
    }

    if (filters.startDate || filters.endDate) {
      query.createdAt = {};
      if (filters.startDate) {
        query.createdAt.$gte = filters.startDate;
      }
      if (filters.endDate) {
        query.createdAt.$lte = filters.endDate;
      }
    }

    const logs = await AuditLog.find(query)
      .sort({ createdAt: -1 })
      .limit(filters.limit || 100)
      .skip(filters.skip || 0)
      .lean();

    return logs;
  } catch (error) {
    serverLogger.error("Error querying audit logs:", error);
    return [];
  }
}

/**
 * Get audit statistics
 */
export async function getAuditStats(
  userId?: string,
  days: number = 30
): Promise<{
  totalActions: number;
  actionsByType: Record<string, number>;
  actionsByDay: Array<{ date: string; count: number }>;
  topIPs: Array<{ ip: string; count: number }>;
  errorRate: number;
}> {
  try {
    await connectDB();

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const query: any = {
      createdAt: { $gte: startDate },
    };

    if (userId) {
      query.userId = new mongoose.Types.ObjectId(userId);
    }

    const logs = await AuditLog.find(query).lean();

    const stats = {
      totalActions: logs.length,
      actionsByType: {} as Record<string, number>,
      actionsByDay: [] as Array<{ date: string; count: number }>,
      topIPs: [] as Array<{ ip: string; count: number }>,
      errorRate: 0,
    };

    const ipCounts: Record<string, number> = {};
    const dayCounts: Record<string, number> = {};
    let errorCount = 0;

    logs.forEach((log: any) => {
      // Count by action type
      stats.actionsByType[log.action] =
        (stats.actionsByType[log.action] || 0) + 1;

      // Count by day
      const date = new Date(log.createdAt).toISOString().split("T")[0];
      dayCounts[date] = (dayCounts[date] || 0) + 1;

      // Count by IP
      ipCounts[log.ip] = (ipCounts[log.ip] || 0) + 1;

      // Count errors
      if (!log.success) {
        errorCount++;
      }
    });

    // Convert day counts to array
    stats.actionsByDay = Object.entries(dayCounts)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Get top IPs
    stats.topIPs = Object.entries(ipCounts)
      .map(([ip, count]) => ({ ip, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Calculate error rate
    stats.errorRate =
      logs.length > 0 ? (errorCount / logs.length) * 100 : 0;

    return stats;
  } catch (error) {
    serverLogger.error("Error getting audit stats:", error);
    return {
      totalActions: 0,
      actionsByType: {},
      actionsByDay: [],
      topIPs: [],
      errorRate: 0,
    };
  }
}

export { AuditLog };

