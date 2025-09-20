import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import type { Part, AssistantMessage, UserMessage, Session, Event, EventMessageUpdated, EventMessagePartUpdated, EventSessionError } from "@opencode-ai/sdk";

export type OpencodeMessage = {
  type: "system" | "assistant" | "user" | "result" | "error";
  sessionID: string;
  messageID?: string;
  content?: string;
  parts?: Array<Part>;
  error?: string;
  model?: string;
  tools?: string[];
};

let serverProcess: ChildProcess | null = null;
let client: OpencodeClient | null = null;

async function getOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => {
          resolve(port);
        });
      } else {
        reject(new Error("Failed to get port"));
      }
    });
    server.on("error", reject);
  });
}

async function waitForServer(port: number, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const endpoints = [
        `http://localhost:${port}/api/health`,
        `http://localhost:${port}/`,
        `http://localhost:${port}/api`,
      ];

      for (const endpoint of endpoints) {
        try {
          const response = await fetch(endpoint);
          if (response.status < 500) {
            console.log(`OpenCode server ready on port ${port}`);
            return true;
          }
        } catch (e) {
          // Continue to next endpoint
        }
      }
    } catch (e) {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Server did not start on port ${port} after ${maxAttempts} seconds`);
}

async function startOpencodeServer(port: number): Promise<ChildProcess> {
  console.log(`Starting OpenCode server on port ${port}...`);

  const server = spawn("opencode", ["serve", "--port", port.toString()], {
    stdio: "pipe",
    detached: false,
    env: {
      ...process.env,
      OPENCODE_PORT: port.toString(),
    },
  });

  server.stdout?.on("data", (data) => {
    console.log(`[OpenCode] ${data.toString().trim()}`);
  });

  server.stderr?.on("data", (data) => {
    console.error(`[OpenCode Error] ${data.toString().trim()}`);
  });

  server.on("error", (error) => {
    console.error("Failed to start OpenCode server:", error);
  });

  await waitForServer(port);
  return server;
}

async function initializeOpencode() {
  if (!serverProcess || serverProcess.killed) {
    const port = await getOpenPort();
    serverProcess = await startOpencodeServer(port);
    client = createOpencodeClient({ baseUrl: `http://localhost:${port}` });
  }

  return client!;
}

export async function runOpencode({
  prompt,
  sessionID,
  onMessage,
}: {
  prompt: string;
  sessionID?: string;
  onMessage?: (message: OpencodeMessage) => Promise<void>;
}) {
  const client = await initializeOpencode();

  let session: Session | undefined;

  if (sessionID) {
    try {
      const sessionResponse = await client.session.get({
        path: { id: sessionID },
      });
      session = sessionResponse.data;
    } catch (error) {
      console.log("Session not found, creating new one");
    }
  }

  if (!session) {
    const sessionResponse = await client.session.create({
      body: { title: prompt.slice(0, 80) },
    });
    session = sessionResponse.data;
  }

  if (!session) {
    throw new Error("Failed to create or get session");
  }

  // Get model info for system message
  const providersResponse = await client.config.providers({});
  const providers = providersResponse.data?.providers || [];
  
  // Find first available model
  let modelInfo = { providerID: "openai", modelID: "gpt-4" };
  for (const provider of providers) {
    if (provider.models && Object.keys(provider.models).length > 0) {
      const firstModelId = Object.keys(provider.models)[0];
      if (firstModelId) {
        modelInfo = {
          providerID: provider.id,
          modelID: firstModelId,
        };
        break;
      }
    }
  }

  if (onMessage) {
    await onMessage({
      type: "system",
      sessionID: session.id,
      model: `${modelInfo.providerID}/${modelInfo.modelID}`,
      tools: ["bash", "edit", "read", "write", "list", "grep", "glob"],
    });
  }

  // Subscribe to events before sending the prompt
  const eventsResult = await client.event.subscribe();
  const events = eventsResult.stream;

  const messageParts = new Map<string, Array<Part>>();
  const processedUserMessages = new Set<string>();
  let assistantMessageId: string | null = null;
  let messageCompleted = false;

  // Start listening to events
  const eventHandler = (async () => {
    try {
      for await (const event of events) {
        // Check if this event is for our session
        if ('properties' in event && 'sessionID' in event.properties) {
          const eventSessionID = (event.properties as { sessionID?: string }).sessionID;
          if (eventSessionID !== session.id) continue;
        } else if (event.type === "message.part.updated") {
          const partEvent = event as EventMessagePartUpdated;
          if (partEvent.properties.part.sessionID !== session.id) continue;
          
          const { part } = partEvent.properties;
          const messageID = part.messageID;

          if (!messageParts.has(messageID)) {
            messageParts.set(messageID, []);
          }

          const parts = messageParts.get(messageID)!;
          const existingIndex = parts.findIndex((p) => p.id === part.id);

          if (existingIndex >= 0) {
            parts[existingIndex] = part;
          } else {
            parts.push(part);
          }

          // Update assistant message
          if (assistantMessageId === messageID && onMessage) {
            await onMessage({
              type: "assistant",
              sessionID: session.id,
              messageID,
              parts: parts,
            });
          }
        } else if (event.type === "message.updated") {
          const msgEvent = event as EventMessageUpdated;
          if (msgEvent.properties.info.sessionID !== session.id) continue;
          
          const message = msgEvent.properties.info;

          if (message.role === "user" && !processedUserMessages.has(message.id)) {
            processedUserMessages.add(message.id);
            if (onMessage) {
              const parts = messageParts.get(message.id) || [];
              const textPart = parts.find(p => p.type === "text");
              const textContent = textPart && 'text' in textPart ? textPart.text : prompt;
              await onMessage({
                type: "user",
                sessionID: session.id,
                messageID: message.id,
                content: textContent,
                parts: parts,
              });
            }
          }

          if (message.role === "assistant") {
            const assistantMsg = message as AssistantMessage;
            assistantMessageId = message.id;
            
            if (assistantMsg.time?.completed) {
              messageCompleted = true;
              if (onMessage) {
                await onMessage({
                  type: "result",
                  sessionID: session.id,
                  content: "Complete",
                });
              }
              break;
            }
          }
        } else if (event.type === "session.error") {
          const errorEvent = event as EventSessionError;
          if (errorEvent.properties.sessionID === session.id && onMessage) {
            const errorMessage = errorEvent.properties.error ? 
              ('message' in errorEvent.properties.error.data ? 
                errorEvent.properties.error.data.message : 
                'Unknown error') : 
              'Unknown error';
            await onMessage({
              type: "error",
              sessionID: session.id,
              error: errorMessage as string,
            });
          }
          break;
        }
      }
    } finally {
      // Stream doesn't have abort, it will close automatically
    }
  })();

  // Send the prompt
  try {
    const response = await client.session.prompt({
      path: { id: session.id },
      body: {
        parts: [{ type: "text", text: prompt }],
        model: modelInfo,
      },
    });

    // Wait for event handler to complete
    await eventHandler;

    return { sessionID: session.id, result: response.data };
  } catch (error) {
    // Stream doesn't have abort, it will close automatically
    if (onMessage) {
      await onMessage({
        type: "error",
        sessionID: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

export async function stopOpencode() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
    client = null;
  }
}