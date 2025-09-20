#!/usr/bin/env bun

import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import type { Part, Session, Event, EventMessageUpdated, EventMessagePartUpdated } from "@opencode-ai/sdk";

// Color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

let serverProcess: ChildProcess | null = null;

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
      const response = await fetch(`http://localhost:${port}/api/health`);
      if (response.status < 500) {
        console.log(`${colors.green}OpenCode server ready on port ${port}${colors.reset}`);
        return true;
      }
    } catch (e) {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Server did not start on port ${port} after ${maxAttempts} seconds`);
}

async function startOpencodeServer(port: number): Promise<ChildProcess> {
  console.log(`${colors.cyan}Starting OpenCode server on port ${port}...${colors.reset}`);

  const server = spawn("opencode", ["serve", "--port", port.toString()], {
    stdio: "pipe",
    detached: false,
    env: {
      ...process.env,
      OPENCODE_PORT: port.toString(),
    },
  });

  server.stdout?.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg) console.log(`${colors.gray}[OpenCode] ${msg}${colors.reset}`);
  });

  server.stderr?.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg) console.error(`${colors.yellow}[OpenCode Error] ${msg}${colors.reset}`);
  });

  server.on("error", (error) => {
    console.error(`${colors.red}Failed to start OpenCode server:${colors.reset}`, error);
  });

  await waitForServer(port);
  return server;
}

function formatPart(part: Part): string {
  const timestamp = new Date().toISOString().split("T")[1].slice(0, 8);
  let icon = "❓";
  let content = "";
  
  switch (part.type) {
    case "text":
      icon = "📝";
      content = part.text.slice(0, 100) + (part.text.length > 100 ? "..." : "");
      break;
    case "reasoning":
      icon = "🤔";
      content = part.text.slice(0, 100) + (part.text.length > 100 ? "..." : "");
      break;
    case "tool":
      icon = "🔧";
      const tool = part;
      if (tool.state.status === "pending") {
        content = `${tool.tool} (pending)`;
      } else if (tool.state.status === "running") {
        content = `${tool.tool} - ${tool.state.title || "Running..."}`;
      } else if (tool.state.status === "completed") {
        content = `${tool.tool} ✓ ${tool.state.title || ""}`;
      } else if (tool.state.status === "error") {
        content = `${tool.tool} ✗ Error`;
      }
      break;
    case "file":
      icon = "📎";
      content = `${part.filename || part.url} (${part.mime})`;
      break;
    case "step-start":
      icon = "▶️";
      content = "Step started";
      break;
    case "step-finish":
      icon = "⏹️";
      content = "Step finished";
      break;
    case "snapshot":
      icon = "📸";
      content = "Snapshot created";
      break;
    case "patch":
      icon = "🔨";
      content = `Patch for ${part.files.length} file(s)`;
      break;
    case "agent":
      icon = "🤖";
      content = `Agent: ${part.name}`;
      break;
  }
  
  return `${colors.gray}[${timestamp}]${colors.reset} ${icon} ${colors.bright}${part.type}${colors.reset} ${colors.dim}(${part.id.slice(0, 8)})${colors.reset}: ${content}`;
}

async function watchLastSession() {
  console.log(`${colors.bright}${colors.magenta}=== OpenCode Session Watcher ===${colors.reset}\n`);
  
  // Start server
  const port = await getOpenPort();
  serverProcess = await startOpencodeServer(port);
  
  // Create client
  const client = createOpencodeClient({ baseUrl: `http://localhost:${port}` });
  
  // Get sessions
  console.log(`${colors.cyan}Fetching sessions...${colors.reset}`);
  const sessionsResponse = await client.session.list();
  const sessions = sessionsResponse.data || [];
  
  if (sessions.length === 0) {
    console.log(`${colors.yellow}No sessions found${colors.reset}`);
    process.exit(0);
  }
  
  // Sort by most recent
  const sortedSessions = [...sessions].sort((a, b) => b.time.updated - a.time.updated);
  const lastSession = sortedSessions[0];
  
  if (!lastSession) {
    console.log(`${colors.yellow}No sessions available${colors.reset}`);
    process.exit(0);
  }
  
  console.log(`${colors.green}Found ${sessions.length} session(s)${colors.reset}`);
  console.log(`${colors.bright}Watching session:${colors.reset} ${lastSession.title}`);
  console.log(`  ID: ${lastSession.id}`);
  console.log(`  Directory: ${lastSession.directory}`);
  console.log(`  Created: ${new Date(lastSession.time.created).toLocaleString()}`);
  console.log(`  Updated: ${new Date(lastSession.time.updated).toLocaleString()}`);
  console.log();
  
  // Get existing messages/parts
  console.log(`${colors.cyan}Loading existing messages...${colors.reset}`);
  const messagesResponse = await client.session.messages({ path: { id: lastSession.id } });
  const messages = messagesResponse.data || [];
  
  let totalParts = 0;
  for (const message of messages) {
    const role = message.info.role === "user" ? `${colors.green}USER${colors.reset}` : `${colors.blue}ASSISTANT${colors.reset}`;
    console.log(`\n${colors.bright}Message ${message.info.id.slice(0, 8)} (${role})${colors.reset}`);
    
    for (const part of message.parts) {
      console.log(`  ${formatPart(part)}`);
      totalParts++;
    }
  }
  
  console.log(`\n${colors.cyan}Loaded ${messages.length} messages with ${totalParts} parts${colors.reset}`);
  console.log(`${colors.yellow}Subscribing to live events...${colors.reset}\n`);
  
  // Subscribe to events
  const eventsResult = await client.event.subscribe();
  const events = eventsResult.stream;
  
  // Track parts we've seen
  const seenParts = new Set<string>();
  messages.forEach(m => m.parts.forEach(p => seenParts.add(p.id)));
  
  try {
    for await (const event of events) {
      // Handle message part updates
      if (event.type === "message.part.updated") {
        const partEvent = event as EventMessagePartUpdated;
        const part = partEvent.properties.part;
        
        // Only show if it's for our session
        if (part.sessionID === lastSession.id) {
          const isNew = !seenParts.has(part.id);
          seenParts.add(part.id);
          
          const prefix = isNew ? `${colors.green}[NEW]${colors.reset}` : `${colors.yellow}[UPD]${colors.reset}`;
          console.log(`${prefix} ${formatPart(part)}`);
        }
      }
      
      // Handle message updates
      if (event.type === "message.updated") {
        const msgEvent = event as EventMessageUpdated;
        const message = msgEvent.properties.info;
        
        if (message.sessionID === lastSession.id) {
          const role = message.role === "user" ? "USER" : "ASSISTANT";
          const status = message.role === "assistant" && 'time' in message && message.time.completed 
            ? `${colors.green}COMPLETED${colors.reset}` 
            : `${colors.yellow}IN PROGRESS${colors.reset}`;
          
          console.log(`${colors.bright}[MSG]${colors.reset} ${role} message ${message.id.slice(0, 8)} - ${status}`);
        }
      }
      
      // Handle session updates
      if (event.type === "session.updated") {
        const session = event.properties.info as Session;
        if (session.id === lastSession.id) {
          console.log(`${colors.magenta}[SESSION]${colors.reset} Session updated: ${session.title}`);
        }
      }
      
      // Handle session errors
      if (event.type === "session.error") {
        const errorEvent = event.properties as { sessionID?: string; error?: any };
        if (errorEvent.sessionID === lastSession.id) {
          console.log(`${colors.red}[ERROR]${colors.reset} Session error:`, errorEvent.error);
        }
      }
      
      // Handle session idle
      if (event.type === "session.idle") {
        const idleEvent = event.properties as { sessionID: string };
        if (idleEvent.sessionID === lastSession.id) {
          console.log(`${colors.dim}[IDLE]${colors.reset} Session is idle`);
        }
      }
    }
  } catch (error) {
    console.error(`${colors.red}Stream error:${colors.reset}`, error);
  }
}

// Handle cleanup
async function cleanup() {
  console.log(`\n${colors.yellow}Shutting down...${colors.reset}`);
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
  }
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// Run the watcher
watchLastSession().catch((error) => {
  console.error(`${colors.red}Fatal error:${colors.reset}`, error);
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
  }
  process.exit(1);
});