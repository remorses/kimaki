#!/usr/bin/env bun

import { runOpencode, stopOpencode } from "./src/opencode";
import type { OpencodeMessage } from "./src/opencode";
import type { Part } from "@opencode-ai/sdk";

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

function formatPart(part: Part): string {
  switch (part.type) {
    case "text":
      return `📝 Text: ${part.text}`;
    case "reasoning":
      return `🤔 Reasoning: ${part.text}`;
    case "tool":
      const tool = part;
      if (tool.state.status === "pending") {
        return `⏳ Tool: ${tool.tool} (pending)`;
      } else if (tool.state.status === "running") {
        return `🔄 Tool: ${tool.tool} - ${tool.state.title || "Running..."}`;
      } else if (tool.state.status === "completed") {
        return `✅ Tool: ${tool.tool} - ${tool.state.title}\n   Output: ${tool.state.output.slice(0, 200)}${tool.state.output.length > 200 ? "..." : ""}`;
      } else if (tool.state.status === "error") {
        return `❌ Tool: ${tool.tool} - Error: ${tool.state.error}`;
      }
      break;
    case "file":
      return `📎 File: ${part.filename || part.url} (${part.mime})`;
    default:
      return `❓ ${part.type}`;
  }
  return "";
}

async function handleMessage(message: OpencodeMessage) {
  const timestamp = new Date().toISOString().split("T")[1].slice(0, 8);
  
  switch (message.type) {
    case "system":
      console.log(`\n${colors.gray}[${timestamp}]${colors.reset} ${colors.cyan}🔧 SYSTEM${colors.reset}`);
      console.log(`  Session: ${message.sessionID}`);
      console.log(`  Model: ${message.model}`);
      console.log(`  Tools: ${message.tools?.join(", ")}`);
      break;
      
    case "user":
      console.log(`\n${colors.gray}[${timestamp}]${colors.reset} ${colors.green}👤 USER${colors.reset}`);
      console.log(`  ${message.content}`);
      break;
      
    case "assistant":
      console.log(`\n${colors.gray}[${timestamp}]${colors.reset} ${colors.blue}🤖 ASSISTANT${colors.reset}`);
      if (message.parts) {
        for (const part of message.parts) {
          const formatted = formatPart(part);
          if (formatted) {
            console.log(`  ${formatted}`);
          }
        }
      }
      break;
      
    case "result":
      console.log(`\n${colors.gray}[${timestamp}]${colors.reset} ${colors.green}✨ RESULT${colors.reset}`);
      console.log(`  ${message.content}`);
      break;
      
    case "error":
      console.log(`\n${colors.gray}[${timestamp}]${colors.reset} ${colors.red}❌ ERROR${colors.reset}`);
      console.log(`  ${message.error}`);
      break;
  }
}

async function testOpencode() {
  console.log(`${colors.bright}${colors.magenta}=== OpenCode Test Script ===${colors.reset}\n`);
  
  const prompts = [
    "What is 2+2?",
    // Uncomment to test more complex prompts:
    // "Write a simple hello world in Python",
    // "List the files in the current directory",
  ];
  
  for (const prompt of prompts) {
    console.log(`${colors.yellow}Testing prompt: "${prompt}"${colors.reset}`);
    
    try {
      const result = await runOpencode({
        prompt,
        onMessage: handleMessage,
      });
      
      console.log(`\n${colors.green}Session completed successfully!${colors.reset}`);
      console.log(`Session ID: ${result.sessionID}`);
      
      // Test continuing the session with another message
      if (prompt === prompts[0]) {
        console.log(`\n${colors.yellow}Continuing session with: "Now multiply that by 5"${colors.reset}`);
        
        await runOpencode({
          prompt: "Now multiply that by 5",
          sessionID: result.sessionID,
          onMessage: handleMessage,
        });
      }
      
    } catch (error) {
      console.error(`${colors.red}Test failed:${colors.reset}`, error);
    }
    
    console.log(`\n${colors.dim}${"=".repeat(60)}${colors.reset}\n`);
  }
  
  // Cleanup
  console.log(`${colors.cyan}Stopping OpenCode server...${colors.reset}`);
  await stopOpencode();
  console.log(`${colors.green}Done!${colors.reset}`);
  process.exit(0);
}

// Handle Ctrl+C gracefully
process.on("SIGINT", async () => {
  console.log(`\n${colors.yellow}Shutting down...${colors.reset}`);
  await stopOpencode();
  process.exit(0);
});

// Run the test
testOpencode().catch((error) => {
  console.error(`${colors.red}Fatal error:${colors.reset}`, error);
  stopOpencode();
  process.exit(1);
});