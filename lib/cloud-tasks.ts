import { serverLogger } from "@/lib/server-logger";

let client: any = null;

async function getClient() {
    if (!client) {
        const { CloudTasksClient } = await import("@google-cloud/tasks");
        client = new CloudTasksClient();
    }
    return client;
}

export async function createHttpTask(
  queueName: string,
  url: string,
  payload: any,
  scheduledTime?: number // Epoch seconds
) {


  const project = process.env.GCP_PROJECT_ID;
  const location = process.env.GCP_QUEUE_LOCATION || "us-central1";
  
  if (!project) {
    throw new Error("GCP_PROJECT_ID is not set");
  }

  const cloudClient = await getClient();
  const parent = cloudClient.queuePath(project, location, queueName);

  const task: any = {
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
    const [response] = await cloudClient.createTask({ parent, task });
    serverLogger.info(`[CloudTasks] Created task ${response.name} in queue ${queueName}`);
    return response;
  } catch (error: any) {
    serverLogger.error(`[CloudTasks] Failed to create task: ${error.message}`);
    throw error;
  }
}
