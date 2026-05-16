/**
 * SystemLog service.
 *
 * The capped client-error log table — the public `/api/admin/log-error`
 * endpoint funnels browser-side errors here. Only one write call site today.
 */
import connectDB from "@/lib/mongodb";
import SystemLog from "@/models/SystemLog";
import type { ISystemLog } from "@/models/SystemLog";

export interface SystemLogInput {
  level?: ISystemLog["level"];
  message: string;
  source?: string;
  url?: string;
  stack?: string;
  metadata?: Record<string, unknown>;
  service?: string;
  requestId?: string;
  statusCode?: number;
  ip?: string;
  user?: unknown;
}

/**
 * Persist a system-log row. Defaults `level` to `"error"` and `source` to
 * `"Unknown"` so callers only have to supply `message`.
 */
export async function recordSystemLog(
  input: SystemLogInput
): Promise<ISystemLog> {
  await connectDB();
  return SystemLog.create({
    level: input.level ?? "error",
    message: input.message,
    source: input.source ?? "Unknown",
    url: input.url,
    stack: input.stack,
    metadata: input.metadata,
    service: input.service,
    requestId: input.requestId,
    statusCode: input.statusCode,
    ip: input.ip,
    user: input.user ?? null,
  });
}
