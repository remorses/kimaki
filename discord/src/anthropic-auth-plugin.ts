/**
 * Anthropic OAuth authentication plugin for OpenCode.
 *
 * Source implementation used for this rewrite:
 * - https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/utils/oauth/anthropic.ts
 * - https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/providers/anthropic.ts
 *
 * This plugin rebuilds the Anthropic login and refresh flow around that
 * working pi-mono implementation, then adapts the request/response shaping
 * needed for OpenCode's Anthropic provider integration.
 *
 * Login mode is chosen from environment:
 * - `KIMAKI` set: remote-first pasted callback URL/raw code flow
 * - otherwise: standard localhost auto-complete flow
 */

import type { Plugin } from "@opencode-ai/plugin";
import { generatePKCE } from "@openauthjs/openauth/pkce";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";

const decodeBase64 = (value: string) =>
  typeof atob === "function"
    ? atob(value)
    : Buffer.from(value, "base64").toString("utf8");

const CLIENT_ID = decodeBase64("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CREATE_API_KEY_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const CLAUDE_CODE_VERSION = "2.1.75";
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const OPENCODE_IDENTITY = "You are OpenCode, the best coding agent on the planet.";
const CLAUDE_CODE_BETA = "claude-code-20250219";
const OAUTH_BETA = "oauth-2025-04-20";
const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const DEFAULT_ANTHROPIC_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION}`;
const ANTHROPIC_HOSTS = new Set([
  "api.anthropic.com",
  "claude.ai",
  "console.anthropic.com",
  "platform.claude.com",
]);

const OPENCODE_TO_CLAUDE_CODE_TOOL_NAME: Record<string, string> = {
  bash: "Bash",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  question: "AskUserQuestion",
  read: "Read",
  skill: "Skill",
  task: "Task",
  todowrite: "TodoWrite",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  write: "Write",
};

let pendingRefresh:
  | Promise<OAuthStored>
  | undefined;

function authFilePath() {
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, "opencode", "auth.json");
  }
  return path.join(homedir(), ".local", "share", "opencode", "auth.json");
}

async function withAuthRefreshLock<T>(fn: () => Promise<T>) {
  const file = authFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, "");

  const release = await lockfile.lock(file, {
    realpath: false,
    stale: 30_000,
    update: 15_000,
    retries: {
      factor: 1.3,
      forever: true,
      maxTimeout: 1_000,
      minTimeout: 100,
    },
    onCompromised: () => {},
  });

  try {
    return await fn();
  } finally {
    await release().catch(() => {});
  }
}

type CallbackResult = {
  code: string;
  state: string;
};

type CallbackServerInfo = {
  server: Server;
  redirectUri: string;
  cancelWait: () => void;
  waitForCode: () => Promise<CallbackResult | null>;
};

type AuthorizationInput = {
  code?: string;
  state?: string;
};

type OAuthStored = {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
};

type OAuthSuccess = {
  type: "success";
  provider?: string;
  refresh: string;
  access: string;
  expires: number;
};

type ApiKeySuccess = {
  type: "success";
  provider?: string;
  key: string;
};

type FailedResult = {
  type: "failed";
};

type AuthResult = OAuthSuccess | ApiKeySuccess | FailedResult;

type RequestRewrite = {
  body: string | undefined;
  modelId?: string;
  reverseToolNameMap: Map<string, string>;
};

function isOAuthStored(auth: OAuthStored | { type: string }): auth is OAuthStored {
  return auth.type === "oauth";
}

function getAnthropicUserAgent() {
  return process.env.OPENCODE_ANTHROPIC_USER_AGENT || DEFAULT_ANTHROPIC_USER_AGENT;
}

function resolveUrl(input: Request | string | URL) {
  try {
    if (typeof input === "string" || input instanceof URL) {
      return new URL(input.toString());
    }
    if (input instanceof Request) {
      return new URL(input.url);
    }
  } catch {
    // ignore URL parse errors
  }
  return null;
}

function buildHeaders(input: Request | string | URL, init?: RequestInit) {
  const headers = new Headers();

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value);
    });
  }

  if (init?.headers instanceof Headers) {
    init.headers.forEach((value, key) => {
      headers.set(key, value);
    });
  } else if (Array.isArray(init?.headers)) {
    for (const entry of init.headers) {
      const [key, value] = entry as [string, string];
      if (typeof value !== "undefined") {
        headers.set(key, String(value));
      }
    }
  } else if (init?.headers) {
    for (const [key, value] of Object.entries(init.headers)) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value));
      }
    }
  }

  return headers;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderOauthPage(options: {
  title: string;
  heading: string;
  message: string;
  details?: string;
}) {
  const title = escapeHtml(options.title);
  const heading = escapeHtml(options.heading);
  const message = escapeHtml(options.message);
  const details = options.details ? escapeHtml(options.details) : undefined;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --text: #fafafa;
      --text-dim: #a1a1aa;
      --page-bg: #09090b;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 560px;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 650;
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: var(--text-dim);
      font-size: 15px;
    }
    .details {
      margin-top: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}

function oauthSuccessHtml(message: string) {
  return renderOauthPage({
    title: "Authentication successful",
    heading: "Authentication successful",
    message,
  });
}

function oauthErrorHtml(message: string, details?: string) {
  return renderOauthPage({
    title: "Authentication failed",
    heading: "Authentication failed",
    message,
    details,
  });
}

function formatErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    const details: string[] = [`${error.name}: ${error.message}`];
    const extended = error as Error & {
      cause?: unknown;
      code?: string;
      errno?: number | string;
    };
    if (extended.code) details.push(`code=${extended.code}`);
    if (typeof extended.errno !== "undefined") {
      details.push(`errno=${String(extended.errno)}`);
    }
    if (typeof extended.cause !== "undefined") {
      details.push(`cause=${formatErrorDetails(extended.cause)}`);
    }
    if (error.stack) {
      details.push(`stack=${error.stack}`);
    }
    return details.join("; ");
  }
  return String(error);
}

function parseAuthorizationInput(input: string): AuthorizationInput {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // not a URL
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
}

function closeServer(server: Server) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function startCallbackServer(expectedState: string): Promise<CallbackServerInfo> {
  return new Promise((resolve, reject) => {
    let settleWait: ((value: CallbackResult | null) => void) | undefined;
    const waitForCodePromise = new Promise<CallbackResult | null>((resolveWait) => {
      let settled = false;
      settleWait = (value) => {
        if (settled) return;
        settled = true;
        resolveWait(value);
      };
    });

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || "", "http://localhost");
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthErrorHtml("Callback route not found."));
          return;
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthErrorHtml("Anthropic authentication did not complete.", `Error: ${error}`));
          return;
        }

        if (!code || !state) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthErrorHtml("Missing code or state parameter."));
          return;
        }

        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthErrorHtml("State mismatch."));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(oauthSuccessHtml("Anthropic authentication completed. You can close this window."));
        settleWait?.({ code, state });
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal error");
      }
    });

    server.once("error", reject);
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      resolve({
        server,
        redirectUri: REDIRECT_URI,
        cancelWait: () => settleWait?.(null),
        waitForCode: () => waitForCodePromise,
      });
    });
  });
}

async function requestText(
  urlString: string,
  options: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      body: options.body,
      headers: options.headers,
      method: options.method,
      url: urlString,
    });
    const child = spawn(
      "node",
      [
        "-e",
        `
const input = JSON.parse(process.argv[1]);
(async () => {
  const response = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body,
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(JSON.stringify({ status: response.status, body: text }));
    process.exit(1);
  }
  process.stdout.write(text);
})().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
        `.trim(),
        payload,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Request timed out. url=${urlString}`));
    }, 30_000);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        let details = stderr.trim();
        try {
          const parsed = JSON.parse(details) as { status?: number; body?: string };
          if (typeof parsed.status === "number") {
            reject(
              new Error(
                `HTTP request failed. status=${parsed.status}; url=${urlString}; body=${parsed.body ?? ""}`,
              ),
            );
            return;
          }
        } catch {
          // fall back to raw stderr
        }
        reject(new Error(details || `Node helper exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function postJson(url: string, body: Record<string, string | number>): Promise<string> {
  const requestBody = JSON.stringify(body);

  return requestText(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Length": String(Buffer.byteLength(requestBody)),
      "Content-Type": "application/json",
    },
    body: requestBody,
  });
}

async function exchangeAuthorizationCode(
  code: string,
  state: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthSuccess> {
  let responseBody: string;
  try {
    responseBody = await postJson(TOKEN_URL, {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
  } catch (error) {
    throw new Error(
      `Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
    );
  }

  let tokenData: { access_token: string; refresh_token: string; expires_in: number };
  try {
    tokenData = JSON.parse(responseBody) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
  } catch (error) {
    throw new Error(
      `Token exchange returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
    );
  }

  return {
    type: "success",
    refresh: tokenData.refresh_token,
    access: tokenData.access_token,
    expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
  };
}

async function refreshAnthropicToken(refreshToken: string): Promise<OAuthStored> {
  let responseBody: string;
  try {
    responseBody = await postJson(TOKEN_URL, {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    });
  } catch (error) {
    throw new Error(
      `Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`,
    );
  }

  let data: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  try {
    data = JSON.parse(responseBody) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
  } catch (error) {
    throw new Error(
      `Anthropic token refresh returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
    );
  }

  return {
    type: "oauth",
    refresh: data.refresh_token,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

async function createApiKey(accessToken: string): Promise<ApiKeySuccess> {
  const responseBody = await requestText(CREATE_API_KEY_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  let json: { raw_key: string };
  try {
    json = JSON.parse(responseBody) as { raw_key: string };
  } catch (error) {
    throw new Error(
      `Create API key returned invalid JSON. url=${CREATE_API_KEY_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
    );
  }

  return {
    type: "success",
    key: json.raw_key,
  };
}

function supportsAdaptiveThinking(modelId: string | undefined) {
  if (!modelId) return false;
  return (
    modelId.includes("opus-4-6") ||
    modelId.includes("opus-4.6") ||
    modelId.includes("sonnet-4-6") ||
    modelId.includes("sonnet-4.6")
  );
}

function getRequiredBetas(modelId: string | undefined) {
  const betas = [CLAUDE_CODE_BETA, OAUTH_BETA, FINE_GRAINED_TOOL_STREAMING_BETA];
  if (!supportsAdaptiveThinking(modelId)) {
    betas.push(INTERLEAVED_THINKING_BETA);
  }
  return betas;
}

function mergeBetas(existingValue: string | null, required: string[]) {
  return [
    ...new Set([
      ...required,
      ...(existingValue || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ]),
  ].join(",");
}

function useKimakiRemoteFirstAuth() {
  return Boolean(process.env.KIMAKI);
}

function getAutoInstructions() {
  return "Complete login in your browser on this machine. OpenCode will catch the localhost callback automatically.";
}

function getRemoteFirstInstructions() {
  return "Complete login in your browser, then paste the final redirect URL from the address bar here. Pasting just the authorization code also works. If this browser can reach localhost directly, finish the redirect and then press Enter here to use the captured callback.";
}

function toClaudeCodeToolName(name: string) {
  return OPENCODE_TO_CLAUDE_CODE_TOOL_NAME[name.toLowerCase()] ?? name;
}

function buildReverseToolNameMap(payload: Record<string, unknown>) {
  const reverseToolNameMap = new Map<string, string>();
  const tools = payload.tools;
  if (!Array.isArray(tools)) {
    return reverseToolNameMap;
  }

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const name = (tool as { name?: unknown }).name;
    if (typeof name !== "string") continue;
    reverseToolNameMap.set(toClaudeCodeToolName(name), name);
  }

  return reverseToolNameMap;
}

function sanitizeSystemText(text: string) {
  return text.replaceAll(OPENCODE_IDENTITY, CLAUDE_CODE_IDENTITY);
}

function prependClaudeCodeIdentity(system: unknown) {
  const identityBlock = { type: "text", text: CLAUDE_CODE_IDENTITY };

  if (typeof system === "undefined") {
    return [identityBlock];
  }

  if (typeof system === "string") {
    const sanitized = sanitizeSystemText(system);
    if (sanitized === CLAUDE_CODE_IDENTITY) {
      return [identityBlock];
    }
    return [identityBlock, { type: "text", text: sanitized }];
  }

  if (Array.isArray(system)) {
    const sanitized = system.map((item) => {
      if (typeof item === "string") {
        return { type: "text", text: sanitizeSystemText(item) };
      }
      if (item && typeof item === "object" && (item as { type?: unknown }).type === "text") {
        const text = (item as { text?: unknown }).text;
        if (typeof text === "string") {
          return {
            ...(item as Record<string, unknown>),
            text: sanitizeSystemText(text),
          };
        }
      }
      return item;
    });

    const first = sanitized[0];
    if (
      first &&
      typeof first === "object" &&
      (first as { type?: unknown }).type === "text" &&
      (first as { text?: unknown }).text === CLAUDE_CODE_IDENTITY
    ) {
      return sanitized;
    }

    return [identityBlock, ...sanitized];
  }

  return [identityBlock, system];
}

function rewriteRequestPayload(body: string | undefined): RequestRewrite {
  if (!body || typeof body !== "string") {
    return {
      body,
      reverseToolNameMap: new Map(),
    };
  }

  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    const reverseToolNameMap = buildReverseToolNameMap(payload);
    const modelId = typeof payload.model === "string" ? payload.model : undefined;

    payload.system = prependClaudeCodeIdentity(payload.system);

    if (Array.isArray(payload.tools)) {
      payload.tools = payload.tools.map((tool) => {
        if (!tool || typeof tool !== "object") return tool;
        const name = (tool as { name?: unknown }).name;
        if (typeof name !== "string") return tool;
        return {
          ...(tool as Record<string, unknown>),
          name: toClaudeCodeToolName(name),
        };
      });
    }

    if (
      payload.tool_choice &&
      typeof payload.tool_choice === "object" &&
      (payload.tool_choice as { type?: unknown }).type === "tool"
    ) {
      const name = (payload.tool_choice as { name?: unknown }).name;
      if (typeof name === "string") {
        payload.tool_choice = {
          ...(payload.tool_choice as Record<string, unknown>),
          name: toClaudeCodeToolName(name),
        };
      }
    }

    if (Array.isArray(payload.messages)) {
      payload.messages = payload.messages.map((message) => {
        if (!message || typeof message !== "object") return message;
        const content = (message as { content?: unknown }).content;
        if (!Array.isArray(content)) return message;

        return {
          ...(message as Record<string, unknown>),
          content: content.map((block) => {
            if (!block || typeof block !== "object") return block;
            const typedBlock = block as { type?: unknown; name?: unknown };
            if (typedBlock.type !== "tool_use" || typeof typedBlock.name !== "string") {
              return block;
            }
            return {
              ...(block as Record<string, unknown>),
              name: toClaudeCodeToolName(typedBlock.name),
            };
          }),
        };
      });
    }

    return {
      body: JSON.stringify(payload),
      modelId,
      reverseToolNameMap,
    };
  } catch {
    return {
      body,
      reverseToolNameMap: new Map(),
    };
  }
}

function transformResponseText(text: string, reverseToolNameMap: Map<string, string>) {
  if (reverseToolNameMap.size === 0) {
    return text;
  }

  return text.replace(/"name"\s*:\s*"([^"]+)"/g, (full, name: string) => {
    const original = reverseToolNameMap.get(name);
    if (!original) return full;
    return full.replace(`"${name}"`, `"${original}"`);
  });
}

function wrapResponseStream(response: Response, reverseToolNameMap: Map<string, string>) {
  if (!response.body || reverseToolNameMap.size === 0) {
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let carry = "";

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();

      if (done) {
        const finalText = carry + decoder.decode();
        if (finalText) {
          controller.enqueue(
            encoder.encode(transformResponseText(finalText, reverseToolNameMap)),
          );
        }
        controller.close();
        return;
      }

      carry += decoder.decode(value, { stream: true });
      if (carry.length <= 256) {
        return;
      }

      const output = carry.slice(0, -256);
      carry = carry.slice(-256);
      controller.enqueue(encoder.encode(transformResponseText(output, reverseToolNameMap)));
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function getRequestBody(input: Request | string | URL, init?: RequestInit) {
  if (typeof init?.body === "string") {
    return init.body;
  }

  if (input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return undefined;
    }
  }

  return undefined;
}

async function beginAuthorizationFlow() {
  const pkce = await generatePKCE();
  const callbackServer = await startCallbackServer(pkce.verifier);
  const redirectUri = callbackServer.redirectUri;

  const authParams = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: pkce.verifier,
  });

  return {
    url: `${AUTHORIZE_URL}?${authParams.toString()}`,
    verifier: pkce.verifier,
    redirectUri,
    callbackServer,
  };
}

async function exchangeManualInput(
  input: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthSuccess> {
  const parsed = parseAuthorizationInput(input);
  if (!parsed.code) {
    throw new Error("Missing authorization code in pasted input");
  }
  if (parsed.state && parsed.state !== verifier) {
    throw new Error("OAuth state mismatch in pasted input");
  }
  return exchangeAuthorizationCode(parsed.code, parsed.state ?? verifier, verifier, redirectUri);
}

async function tryReadLocalAuthorization(callbackServer: CallbackServerInfo) {
  return Promise.race([
    callbackServer.waitForCode(),
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), 50);
    }),
  ]);
}

async function resolveAuthorizationCode(
  input: string,
  verifier: string,
  callbackServer: CallbackServerInfo,
): Promise<OAuthSuccess> {
  try {
    const localResult = await tryReadLocalAuthorization(callbackServer);

    if (localResult?.code) {
      return exchangeAuthorizationCode(
        localResult.code,
        localResult.state,
        verifier,
        callbackServer.redirectUri,
      );
    }

    const trimmed = input.trim();
    if (!trimmed) {
      const delayedLocalResult = await Promise.race([
        callbackServer.waitForCode(),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), OAUTH_TIMEOUT_MS);
        }),
      ]);

      if (!delayedLocalResult?.code) {
        throw new Error("Missing authorization code in pasted input");
      }

      return exchangeAuthorizationCode(
        delayedLocalResult.code,
        delayedLocalResult.state,
        verifier,
        callbackServer.redirectUri,
      );
    }

    return exchangeManualInput(trimmed, verifier, callbackServer.redirectUri);
  } finally {
    callbackServer.cancelWait();
    await closeServer(callbackServer.server);
  }
}

async function createApiKeyFromAuthorizationCode(
  input: string,
  verifier: string,
  callbackServer: CallbackServerInfo,
): Promise<ApiKeySuccess> {
  const credentials = await resolveAuthorizationCode(input, verifier, callbackServer);
  return createApiKey(credentials.access);
}

async function runAutoAuthorization(
  verifier: string,
  callbackServer: CallbackServerInfo,
): Promise<OAuthSuccess> {
  try {
    const result = await Promise.race([
      callbackServer.waitForCode(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), OAUTH_TIMEOUT_MS);
      }),
    ]);

    if (!result?.code) {
      throw new Error("Timed out waiting for localhost OAuth callback");
    }

    return exchangeAuthorizationCode(
      result.code,
      result.state,
      verifier,
      callbackServer.redirectUri,
    );
  } finally {
    callbackServer.cancelWait();
    await closeServer(callbackServer.server);
  }
}

async function createApiKeyFromAutoAuthorization(
  verifier: string,
  callbackServer: CallbackServerInfo,
): Promise<ApiKeySuccess> {
  const credentials = await runAutoAuthorization(verifier, callbackServer);
  return createApiKey(credentials.access);
}

function failedResult(error: unknown): FailedResult {
  console.error(`[anthropic-auth] ${formatErrorDetails(error)}`);
  return { type: "failed" };
}

async function getFreshOAuth(
  getAuth: () => Promise<OAuthStored | { type: string }>,
  client: Parameters<Plugin>[0]["client"],
) {
  const auth = await getAuth();
  if (!isOAuthStored(auth)) {
    return undefined;
  }

  if (auth.access && auth.expires > Date.now()) {
    return auth;
  }

  if (!pendingRefresh) {
    pendingRefresh = withAuthRefreshLock(async () => {
      const latest = await getAuth();
      if (!isOAuthStored(latest)) {
        throw new Error("Anthropic OAuth credentials disappeared while waiting for refresh lock");
      }

      if (latest.access && latest.expires > Date.now()) {
        return latest;
      }

      const refreshed = await refreshAnthropicToken(latest.refresh);
      await client.auth.set({
        path: { id: "anthropic" },
        body: refreshed,
      });
      return refreshed;
    }).finally(() => {
      pendingRefresh = undefined;
    });
  }

  return pendingRefresh;
}

function zeroModelCosts(provider: { models: Record<string, { cost?: unknown }> }) {
  for (const model of Object.values(provider.models)) {
    model.cost = {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0,
      },
    };
  }
}

const AnthropicAuthPlugin: Plugin = async ({ client }) => {
  return {
    auth: {
      provider: "anthropic",
      async loader(
        getAuth: () => Promise<OAuthStored | { type: string }>,
        provider: { models: Record<string, { cost?: unknown }> },
      ) {
        const auth = await getAuth();
        if (auth.type !== "oauth") {
          return {};
        }

        zeroModelCosts(provider);

        return {
          apiKey: "",
          async fetch(input: Request | string | URL, init?: RequestInit) {
            const url = resolveUrl(input);
            if (!url || !ANTHROPIC_HOSTS.has(url.hostname)) {
              return fetch(input, init);
            }

            const freshAuth = await getFreshOAuth(getAuth, client);
            if (!freshAuth) {
              return fetch(input, init);
            }

            const originalBody = await getRequestBody(input, init);
            const rewritten = rewriteRequestPayload(originalBody);
            const requestHeaders = buildHeaders(input, init);
            const betas = getRequiredBetas(rewritten.modelId);

            requestHeaders.set("accept", "application/json");
            requestHeaders.set("anthropic-beta", mergeBetas(requestHeaders.get("anthropic-beta"), betas));
            requestHeaders.set("anthropic-dangerous-direct-browser-access", "true");
            requestHeaders.set("authorization", `Bearer ${freshAuth.access}`);
            requestHeaders.set("user-agent", getAnthropicUserAgent());
            requestHeaders.set("x-app", "cli");
            requestHeaders.delete("x-api-key");

            const response = await fetch(input, {
              ...(init ?? {}),
              body: rewritten.body,
              headers: requestHeaders,
            });

            return wrapResponseStream(response, rewritten.reverseToolNameMap);
          },
        };
      },
      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: async () => {
            const auth = await beginAuthorizationFlow();
            if (!useKimakiRemoteFirstAuth()) {
              return {
                url: auth.url,
                instructions: getAutoInstructions(),
                method: "auto" as const,
                callback: async (): Promise<AuthResult> => {
                  try {
                    return await runAutoAuthorization(auth.verifier, auth.callbackServer);
                  } catch (error) {
                    return failedResult(error);
                  }
                },
              };
            }

            return {
              url: auth.url,
              instructions: getRemoteFirstInstructions(),
              method: "code" as const,
              callback: async (input: string): Promise<AuthResult> => {
                try {
                  return await resolveAuthorizationCode(input, auth.verifier, auth.callbackServer);
                } catch (error) {
                  return failedResult(error);
                }
              },
            };
          },
        },
        {
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const auth = await beginAuthorizationFlow();
            if (!useKimakiRemoteFirstAuth()) {
              return {
                url: auth.url,
                instructions: getAutoInstructions(),
                method: "auto" as const,
                callback: async (): Promise<AuthResult> => {
                  try {
                    return await createApiKeyFromAutoAuthorization(
                      auth.verifier,
                      auth.callbackServer,
                    );
                  } catch (error) {
                    return failedResult(error);
                  }
                },
              };
            }

            return {
              url: auth.url,
              instructions: getRemoteFirstInstructions(),
              method: "code" as const,
              callback: async (input: string): Promise<AuthResult> => {
                try {
                  return await createApiKeyFromAuthorizationCode(
                    input,
                    auth.verifier,
                    auth.callbackServer,
                  );
                } catch (error) {
                  return failedResult(error);
                }
              },
            };
          },
        },
        {
          provider: "anthropic",
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  };
};

export { AnthropicAuthPlugin as anthropicAuthPlugin };
