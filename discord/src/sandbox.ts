import ms from "ms";
import { Sandbox } from "@vercel/sandbox";
import { Writable } from "stream";
import type {
  Message,
  MessageParam,
} from "@anthropic-ai/sdk/resources/messages";

export type SDKMessage =
  // An assistant message
  | {
      type: "assistant";
      message: Message; // from Anthropic SDK
      session_id: string;
    }

  // A user message
  | {
      type: "user";
      message: MessageParam; // from Anthropic SDK
      session_id: string;
    }

  // Emitted as the last message
  | {
      type: "result";
      subtype: "success";
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      result: string;
      session_id: string;
      total_cost_usd: number;
    }

  // Emitted as the last message, when we've reached the maximum number of turns
  | {
      type: "result";
      subtype: "error_max_turns" | "error_during_execution";
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      session_id: string;
      total_cost_usd: number;
    }

  // Emitted as the first message at the start of a conversation
  | {
      type: "system";
      subtype: "init";
      apiKeySource: string;
      cwd: string;
      session_id: string;
      tools: string[];
      mcp_servers: {
        name: string;
        status: string;
      }[];
      model: string;
      permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
    };

const apiKey = process.env.ANTHROPIC_API_KEY;

export async function runClaude({
  prompt,
  resume,
  sandboxId,
  onMessage,
}: {
  prompt: string;
  resume?: string;
  sandboxId?: string;
  onMessage?: (
    message: SDKMessage,
    metadata: {
      sandboxId: string;
    }
  ) => void;
}) {
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const sandbox = sandboxId
    ? await Sandbox.get({ sandboxId })
    : await Sandbox.create({
        source: {
          url: "https://github.com/RhysSullivan/basic-bun",
          type: "git",
        },
        resources: { vcpus: 4 },
        timeout: ms("5m"),
        runtime: "node22",
      });

  await sandbox.runCommand({
    cmd: "bash",
    args: ["-c", "curl -fsSL https://bun.sh/install | bash -s"],
  });

  await sandbox.runCommand({
    cmd: "npm",
    args: ["install", "-g", "@anthropic-ai/claude-code"],
  });

  const args = ["-p"];

  if (resume) {
    args.push("--resume");
    args.push(resume);
  }
  args.push(
    ...[
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
      "--append-system-prompt",
      "Prefer using local commands over web searches, i.e use dig to get the ip address of a domain instead of using a web search.s",
    ]
  );

  args.push(prompt);

  await sandbox.runCommand({
    cmd: "claude",
    args,
    stderr: process.stderr,
    stdout: onMessage
      ? new Writable({
          write(chunk, _enc, cb) {
            onMessage(JSON.parse(chunk.toString()) as SDKMessage, {
              sandboxId: sandbox.sandboxId,
            });
            cb();
          },
        })
      : process.stdout,
    env: {
      ANTHROPIC_API_KEY: apiKey,
    },
  });
}
