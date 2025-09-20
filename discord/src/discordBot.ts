import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ThreadAutoArchiveDuration,
  type Message,
  type ThreadChannel,
} from "discord.js";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { 
  createOpencodeClient, 
  type OpencodeClient, 
  type Part,
  type Event,
  type EventMessagePartUpdated,
  type EventMessageUpdated,
  type EventSessionError 
} from "@opencode-ai/sdk";

type StartOptions = {
  token: string;
  channelId: string;
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
        } catch (e) {}
      }
    } catch (e) {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Server did not start on port ${port} after ${maxAttempts} seconds`);
}

async function initializeOpencode() {
  if (!serverProcess || serverProcess.killed) {
    const port = await getOpenPort();
    console.log(`Starting OpenCode server on port ${port}...`);

    serverProcess = spawn("opencode", ["serve", "--port", port.toString()], {
      stdio: "pipe",
      detached: false,
      env: {
        ...process.env,
        OPENCODE_PORT: port.toString(),
      },
    });

    serverProcess.stdout?.on("data", (data) => {
      console.log(`[OpenCode] ${data.toString().trim()}`);
    });

    serverProcess.stderr?.on("data", (data) => {
      console.error(`[OpenCode Error] ${data.toString().trim()}`);
    });

    serverProcess.on("error", (error) => {
      console.error("Failed to start OpenCode server:", error);
    });

    await waitForServer(port);
    client = createOpencodeClient({ baseUrl: `http://localhost:${port}` });
  }

  return client!;
}

function formatPart(part: Part): string {
  switch (part.type) {
    case "text":
      return part.text || "";
    case "reasoning":
      return `💭 ${part.text || ""}`;
    case "tool":
      if (part.state.status === "completed") {
        const output = part.state.output || "";
        const truncated = output.length > 500 ? output.slice(0, 497) + "..." : output;
        return `🔧 ${part.tool}: ${truncated}`;
      }
      return "";
    case "file":
      return `📄 ${part.filename || "File"}`;
    default:
      return "";
  }
}

async function handleOpencodeSession(
  prompt: string,
  thread: ThreadChannel,
  threadToSession: Map<string, string>
) {
  const client = await initializeOpencode();
  
  let sessionId = threadToSession.get(thread.id);
  let session;

  if (sessionId) {
    try {
      const sessionResponse = await client.session.get({ path: { id: sessionId } });
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

  threadToSession.set(thread.id, session.id);

  const eventsResult = await client.event.subscribe();
  const events = eventsResult.stream;

  let currentMessage: Message | undefined;
  let currentParts: Part[] = [];
  let lastUpdateTime = 0;

  const updateMessage = async () => {
    if (!currentMessage || currentParts.length === 0) return;
    
    const content = currentParts
      .map(formatPart)
      .filter(text => text.length > 0)
      .join("\n\n");
    
    if (content.length > 0) {
      try {
        await currentMessage.edit(content.slice(0, 2000));
      } catch (error) {
        console.error("Failed to update message:", error);
      }
    }
  };

  const eventHandler = (async () => {
    try {
      let assistantMessageId: string | undefined;
      
      for await (const event of events) {
        if (event.type === "message.updated") {
          const msgEvent = event as EventMessageUpdated;
          const message = msgEvent.properties.info;
          
          if (message.sessionID !== session.id) continue;
          
          // Track assistant message ID
          if (message.role === "assistant") {
            assistantMessageId = message.id;
            
            if (message.time?.completed) {
              // Final update when message completes
              await updateMessage();
              break;
            }
          }
        } else if (event.type === "message.part.updated") {
          const partEvent = event as EventMessagePartUpdated;
          const part = partEvent.properties.part;
          
          if (part.sessionID !== session.id) continue;
          
          // Only process parts from assistant messages
          if (part.messageID !== assistantMessageId) continue;
          
          const existingIndex = currentParts.findIndex((p: Part) => p.id === part.id);
          if (existingIndex >= 0) {
            currentParts[existingIndex] = part;
          } else {
            currentParts.push(part);
          }

          // Only update when parts complete (not on every streaming update)
          if (part.type === "tool" && part.state?.status === "completed") {
            const now = Date.now();
            if (now - lastUpdateTime > 100) {
              if (!currentMessage) {
                const initialContent = formatPart(part);
                if (initialContent) {
                  currentMessage = await thread.send(initialContent.slice(0, 2000));
                }
              } else {
                await updateMessage();
              }
              lastUpdateTime = now;
            }
          } else if (part.type === "text" || part.type === "reasoning") {
            const now = Date.now();
            if (now - lastUpdateTime > 100) {
              if (!currentMessage) {
                const initialContent = formatPart(part);
                if (initialContent) {
                  currentMessage = await thread.send(initialContent.slice(0, 2000));
                }
              } else {
                await updateMessage();
              }
              lastUpdateTime = now;
            }
          }
        } else if (event.type === "session.error") {
          const errorEvent = event as EventSessionError;
          if (errorEvent.properties.sessionID === session.id) {
            const errorData = errorEvent.properties.error;
            const errorMessage = errorData?.data?.message || "Unknown error";
            await thread.send(`❌ Error: ${errorMessage}`);
          }
          break;
        }
      }
    } finally {}
  })();

  try {
    const response = await client.session.prompt({
      path: { id: session.id },
      body: {
        parts: [{ type: "text", text: prompt }],
      },
    });

    await eventHandler;
    return { sessionID: session.id, result: response.data };
  } catch (error) {
    await thread.send(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export async function startDiscordBot({ token, channelId }: StartOptions) {
  const discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.User,
      Partials.ThreadMember,
    ],
  });

  const threadToSession = new Map<string, string>();

  discordClient.once(Events.ClientReady, (c) => {
    console.log(`Discord bot logged in as ${c.user.tag}`);
  });

  discordClient.on(Events.MessageCreate, async (message: Message) => {
    try {
      if (message.author?.bot) return;
      if (message.partial) {
        try {
          await message.fetch();
        } catch {
          return;
        }
      }

      if (message.channelId === channelId) {
        const baseName = message.content.replace(/\s+/g, " ").trim();
        const name = (baseName || "Claude Thread").slice(0, 80);

        const thread = await message.startThread({
          name: name.length > 0 ? name : "Claude Thread",
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          reason: "Start Claude session",
        });

        await thread.send("Starting OpenCode session…");
        await handleOpencodeSession(message.content || "", thread, threadToSession);
        return;
      }

      const channel = message.channel;
      const isThreadChannel = 
        channel.type === ChannelType.PublicThread ||
        channel.type === ChannelType.PrivateThread ||
        channel.type === ChannelType.AnnouncementThread;

      if (isThreadChannel) {
        const thread = channel as ThreadChannel;
        const existing = threadToSession.get(thread.id);
        if (!existing) return;

        const thinkingMessage = await thread.send("Thinking…");
        await handleOpencodeSession(message.content || "", thread, threadToSession);
        await thinkingMessage.delete();
      }
    } catch (error) {
      console.error("Discord handler error:", error);
      try {
        const errMsg = error instanceof Error ? error.message : String(error);
        await message.reply(`Error: ${errMsg}`);
      } catch {
        console.error("Discord handler error (fallback):", error);
      }
    }
  });

  await discordClient.login(token);

  process.on("SIGINT", () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill("SIGTERM");
    }
    discordClient.destroy();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill("SIGTERM");
    }
    discordClient.destroy();
    process.exit(0);
  });
}