import { serverLogger } from "@/lib/server-logger";
// CloudTasksClient is dynamically imported to avoid pulling
// @google-cloud/tasks into the bundle at module-load time. The runtime
// values are typed via the SDK's own types where possible.
type LazyCloudTasksClient = Awaited<ReturnType<typeof importCloudTasks>>;

async function importCloudTasks() {
    const m = await import("@google-cloud/tasks");
    return new m.CloudTasksClient();
}

let client: LazyCloudTasksClient | null = null;

async function getClient(): Promise<LazyCloudTasksClient> {
    if (!client) {
        client = await importCloudTasks();
    }
    return client;
}

export async function createHttpTask(
  queueName: string,
  url: string,
  payload: unknown,
  scheduledTime?: number // Epoch seconds
) {


  const project = process.env.GCP_PROJECT_ID;
  const location = process.env.GCP_QUEUE_LOCATION || "us-central1";
  
  if (!project) {
    throw new Error("GCP_PROJECT_ID is not set");
  }

  const cloudClient = await getClient();
  const parent = cloudClient.queuePath(project, location, queueName);

  interface CloudTask {
    httpRequest: {
      httpMethod: string;
      url: string;
      headers: Record<string, string>;
      body: string;
    };
    scheduleTime?: { seconds: number };
  }
  const task: CloudTask = {
    httpRequest: {
      httpMethod: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
        // Pass the cron secret to authenticate the worker
        "x-cron-secret": process.env.CRON_SECRET || "",
      },
      body: Buffer.from(JSON.stringify(payload)).toString("base64"),
    },
  };

  if (scheduledTime) {
    task.scheduleTime = {
      seconds: scheduledTime,
    };
  }

  try {
    const cloudClient = await getClient();
    // The SDK's ITask type narrows httpMethod to a union and other fields
    // to discriminated unions; our locally-typed CloudTask is structurally
    // compatible at runtime. Cast through unknown rather than fight the
    // SDK's strict generated types.
    const [response] = await cloudClient.createTask({
      parent,
      task: task as unknown as Parameters<typeof cloudClient.createTask>[0]["task"],
    });
    serverLogger.info(`[CloudTasks] Created task ${response.name} in queue ${queueName}`);
    return response;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error(`[CloudTasks] Failed to create task: ${message}`);
    throw error;
  }
}
