/**
 * Tests for `@/lib/cloud-tasks` (rescan-4 slice 7do).
 * createHttpTask creates a Cloud Tasks HTTP task. Mocks @google-cloud/
 * tasks's CloudTasksClient via vi.mock. Pins:
 *  - Throws when GCP_PROJECT_ID is unset
 *  - parent path built from project + location (default 'us-central1')
 *  - task payload: POST + JSON Content-Type + base64-encoded body +
 *    x-cron-secret header carrying CRON_SECRET
 *  - scheduledTime appears in task.scheduleTime.seconds when supplied
 *  - createTask errors → logged + rethrown
 *  - Client is lazy-imported AND cached across calls
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const queuePathMock = vi.hoisted(() => vi.fn());
const createTaskMock = vi.hoisted(() => vi.fn());
const ClientCtorMock = vi.hoisted(() => vi.fn());
class FakeCloudTasksClient {
  queuePath = queuePathMock;
  createTask = createTaskMock;
  constructor() {
    ClientCtorMock();
  }
}
vi.mock("@google-cloud/tasks", () => ({
  CloudTasksClient: FakeCloudTasksClient,
}));

const loggerInfo = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: loggerInfo, error: loggerError, warn: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  queuePathMock.mockReset();
  createTaskMock.mockReset();
  ClientCtorMock.mockClear();
  loggerInfo.mockReset();
  loggerError.mockReset();
  vi.stubEnv("GCP_PROJECT_ID", "test-project");
  vi.stubEnv("GCP_QUEUE_LOCATION", "us-central1");
  vi.stubEnv("CRON_SECRET", "supersecret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createHttpTask", () => {
  it("throws when GCP_PROJECT_ID is unset", async () => {
    vi.stubEnv("GCP_PROJECT_ID", "");
    const { createHttpTask } = await import("@/lib/cloud-tasks");
    await expect(createHttpTask("q1", "/api/x", { a: 1 })).rejects.toThrow(
      /GCP_PROJECT_ID is not set/
    );
  });

  it("builds parent via queuePath(project, location, queueName) + creates the task with the expected shape", async () => {
    queuePathMock.mockReturnValueOnce("projects/test-project/locations/us-central1/queues/q1");
    createTaskMock.mockResolvedValueOnce([{ name: "task-1" }]);
    const { createHttpTask } = await import("@/lib/cloud-tasks");
    await createHttpTask("q1", "https://worker.example.com/run", { foo: "bar" });
    expect(queuePathMock).toHaveBeenCalledWith("test-project", "us-central1", "q1");
    const [arg] = createTaskMock.mock.calls[0];
    expect(arg.parent).toBe("projects/test-project/locations/us-central1/queues/q1");
    expect(arg.task.httpRequest.httpMethod).toBe("POST");
    expect(arg.task.httpRequest.url).toBe("https://worker.example.com/run");
    expect(arg.task.httpRequest.headers["Content-Type"]).toBe("application/json");
    expect(arg.task.httpRequest.headers["x-cron-secret"]).toBe("supersecret");
    // Body is base64-encoded JSON.
    const decoded = JSON.parse(Buffer.from(arg.task.httpRequest.body, "base64").toString("utf8"));
    expect(decoded).toEqual({ foo: "bar" });
    // No scheduleTime when not supplied.
    expect(arg.task.scheduleTime).toBeUndefined();
  });

  it("default location 'us-central1' when GCP_QUEUE_LOCATION is unset", async () => {
    vi.stubEnv("GCP_QUEUE_LOCATION", "");
    queuePathMock.mockReturnValueOnce("p/test-project/l/us-central1/q/q1");
    createTaskMock.mockResolvedValueOnce([{ name: "t" }]);
    const { createHttpTask } = await import("@/lib/cloud-tasks");
    await createHttpTask("q1", "/api/x", {});
    expect(queuePathMock).toHaveBeenCalledWith("test-project", "us-central1", "q1");
  });

  it("scheduledTime is forwarded to task.scheduleTime.seconds", async () => {
    queuePathMock.mockReturnValueOnce("path");
    createTaskMock.mockResolvedValueOnce([{ name: "t" }]);
    const { createHttpTask } = await import("@/lib/cloud-tasks");
    await createHttpTask("q1", "/api/x", {}, 1_700_000_000);
    const arg = createTaskMock.mock.calls[0][0];
    expect(arg.task.scheduleTime).toEqual({ seconds: 1_700_000_000 });
  });

  it("createTask rejection → error log + rethrow", async () => {
    queuePathMock.mockReturnValueOnce("path");
    createTaskMock.mockRejectedValueOnce(new Error("quota exceeded"));
    const { createHttpTask } = await import("@/lib/cloud-tasks");
    await expect(createHttpTask("q1", "/api/x", {})).rejects.toThrow("quota exceeded");
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toMatch(/quota exceeded/);
  });

  it("CloudTasksClient is constructed once and cached across calls", async () => {
    queuePathMock.mockReturnValue("path");
    createTaskMock.mockResolvedValue([{ name: "t" }]);
    const { createHttpTask } = await import("@/lib/cloud-tasks");
    await createHttpTask("q1", "/api/a", {});
    await createHttpTask("q2", "/api/b", {});
    await createHttpTask("q3", "/api/c", {});
    expect(ClientCtorMock).toHaveBeenCalledTimes(1);
  });

  it("missing CRON_SECRET → x-cron-secret header is the empty string (defensive default, not absent)", async () => {
    vi.stubEnv("CRON_SECRET", "");
    queuePathMock.mockReturnValueOnce("path");
    createTaskMock.mockResolvedValueOnce([{ name: "t" }]);
    const { createHttpTask } = await import("@/lib/cloud-tasks");
    await createHttpTask("q1", "/api/x", {});
    const arg = createTaskMock.mock.calls[0][0];
    expect(arg.task.httpRequest.headers["x-cron-secret"]).toBe("");
  });
});
