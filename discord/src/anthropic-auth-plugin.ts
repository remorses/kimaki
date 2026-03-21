/**
 * Anthropic OAuth authentication plugin for OpenCode.
 *
 * Handles two concerns:
 * 1. OAuth login + token refresh (PKCE flow against claude.ai)
 * 2. Request/response rewriting (tool names, system prompt, beta headers)
 *    so the Anthropic API treats requests as Claude Code CLI requests.
 *
 * Login mode is chosen from environment:
 * - `KIMAKI` set: remote-first pasted callback URL/raw code flow
 * - otherwise: standard localhost auto-complete flow
 *
 * Source references:
 * - https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/utils/oauth/anthropic.ts
 * - https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/providers/anthropic.ts
 */

import type { Plugin } from "@opencode-ai/plugin";
import { generatePKCE } from "@openauthjs/openauth/pkce";
import * as fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";

// --- Constants ---

const CLIENT_ID = (() => {
  const encoded = "OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl";
  return typeof atob === "function"
    ? atob(encoded)
    : Buffer.from(encoded, "base64").toString("utf8");
})();

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CREATE_API_KEY_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key";
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

// --- Types ---

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

type AuthResult = OAuthSuccess | ApiKeySuccess | { type: "failed" };

// --- HTTP helpers ---

async function postJson(url: string, body: Record<string, string | number>): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} from ${url}: ${text}`);
  }
  return response.json();
}

// --- File lock for token refresh ---

let pendingRefresh: Promise<OAuthStored> | undefined;

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
    retries: { factor: 1.3, forever: true, maxTimeout: 1_000, minTimeout: 100 },
    onCompromised: () => {},
  });

  try {
    return await fn();
  } finally {
    await release().catch(() => {});
  }
}

// --- OAuth token exchange & refresh ---

function parseTokenResponse(json: unknown): { access_token: string; refresh_token: string; expires_in: number } {
  const data = json as { access_token: string; refresh_token: string; expires_in: number };
  if (!data.access_token || !data.refresh_token) {
    throw new Error(`Invalid token response: ${JSON.stringify(json)}`);
  }
  return data;
}

function tokenExpiry(expiresIn: number) {
  return Date.now() + expiresIn * 1000 - 5 * 60 * 1000;
}

async function exchangeAuthorizationCode(
  code: string,
  state: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthSuccess> {
  const json = await postJson(TOKEN_URL, {
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    state,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const data = parseTokenResponse(json);
  return {
    type: "success",
    refresh: data.refresh_token,
    access: data.access_token,
    expires: tokenExpiry(data.expires_in),
  };
}

async function refreshAnthropicToken(refreshToken: string): Promise<OAuthStored> {
  const json = await postJson(TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });
  const data = parseTokenResponse(json);
  return {
    type: "oauth",
    refresh: data.refresh_token,
    access: data.access_token,
    expires: tokenExpiry(data.expires_in),
  };
}

async function createApiKey(accessToken: string): Promise<ApiKeySuccess> {
  const response = await fetch(CREATE_API_KEY_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} creating API key: ${text}`);
  }
  const json = (await response.json()) as { raw_key: string };
  return { type: "success", key: json.raw_key };
}

// --- Localhost callback server ---

type CallbackResult = { code: string; state: string };

async function startCallbackServer(expectedState: string) {
  return new Promise<{
    server: Server;
    cancelWait: () => void;
    waitForCode: () => Promise<CallbackResult | null>;
  }>((resolve, reject) => {
    let settle: ((value: CallbackResult | null) => void) | undefined;
    let settled = false;
    const waitPromise = new Promise<CallbackResult | null>((res) => {
      settle = (v) => {
        if (settled) return;
        settled = true;
        res(v);
      };
    });

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || "", "http://localhost");
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end("Not found");
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        if (error || !code || !state || state !== expectedState) {
          res.writeHead(400).end("Authentication failed: " + (error || "missing code/state"));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" }).end("Authentication successful. You can close this window.");
        settle?.({ code, state });
      } catch {
        res.writeHead(500).end("Internal error");
      }
    });

    server.once("error", reject);
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      resolve({
        server,
        cancelWait: () => { settle?.(null); },
        waitForCode: () => waitPromise,
      });
    });
  });
}

function closeServer(server: Server) {
  return new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
}

// --- Authorization flow ---
// Unified flow: beginAuthorizationFlow starts PKCE + callback server,
// then waitForCallback handles both auto (localhost) and manual (pasted code) paths.

async function beginAuthorizationFlow() {
  const pkce = await generatePKCE();
  const callbackServer = await startCallbackServer(pkce.verifier);

  const authParams = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: pkce.verifier,
  });

  return {
    url: `https://claude.ai/oauth/authorize?${authParams.toString()}`,
    verifier: pkce.verifier,
    callbackServer,
  };
}

async function waitForCallback(
  callbackServer: Awaited<ReturnType<typeof startCallbackServer>>,
  manualInput?: string,
): Promise<CallbackResult> {
  try {
    // Try localhost callback first (instant check)
    const quick = await Promise.race([
      callbackServer.waitForCode(),
      new Promise<null>((r) => { setTimeout(() => { r(null); }, 50); }),
    ]);
    if (quick?.code) return quick;

    // If manual input was provided, parse it
    const trimmed = manualInput?.trim();
    if (trimmed) {
      return parseManualInput(trimmed);
    }

    // Wait for localhost callback with timeout
    const result = await Promise.race([
      callbackServer.waitForCode(),
      new Promise<null>((r) => { setTimeout(() => { r(null); }, OAUTH_TIMEOUT_MS); }),
    ]);
    if (!result?.code) {
      throw new Error("Timed out waiting for OAuth callback");
    }
    return result;
  } finally {
    callbackServer.cancelWait();
    await closeServer(callbackServer.server);
  }
}

function parseManualInput(input: string): CallbackResult {
  try {
    const url = new URL(input);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code) return { code, state: state || "" };
  } catch {
    // not a URL
  }
  if (input.includes("#")) {
    const [code = "", state = ""] = input.split("#", 2);
    return { code, state };
  }
  if (input.includes("code=")) {
    const params = new URLSearchParams(input);
    const code = params.get("code");
    if (code) return { code, state: params.get("state") || "" };
  }
  return { code: input, state: "" };
}

// Unified authorize handler: returns either OAuth tokens or an API key,
// for both auto and remote-first modes.
function buildAuthorizeHandler(mode: "oauth" | "apikey") {
  return async () => {
    const auth = await beginAuthorizationFlow();
    const isRemote = Boolean(process.env.KIMAKI);

    const finalize = async (result: CallbackResult): Promise<AuthResult> => {
      const verifier = auth.verifier;
      const creds = await exchangeAuthorizationCode(
        result.code,
        result.state || verifier,
        verifier,
        REDIRECT_URI,
      );
      if (mode === "apikey") {
        return createApiKey(creds.access);
      }
      return creds;
    };

    if (!isRemote) {
      return {
        url: auth.url,
        instructions: "Complete login in your browser on this machine. OpenCode will catch the localhost callback automatically.",
        method: "auto" as const,
        callback: async (): Promise<AuthResult> => {
          try {
            const result = await waitForCallback(auth.callbackServer);
            return finalize(result);
          } catch (error) {
            console.error(`[anthropic-auth] ${error}`);
            return { type: "failed" };
          }
        },
      };
    }

    return {
      url: auth.url,
      instructions: "Complete login in your browser, then paste the final redirect URL from the address bar here. Pasting just the authorization code also works.",
      method: "code" as const,
      callback: async (input: string): Promise<AuthResult> => {
        try {
          const result = await waitForCallback(auth.callbackServer, input);
          return finalize(result);
        } catch (error) {
          console.error(`[anthropic-auth] ${error}`);
          return { type: "failed" };
        }
      },
    };
  };
}

// --- Request/response rewriting ---
// Renames opencode tool names to Claude Code tool names in requests,
// and reverses the mapping in streamed responses.

function toClaudeCodeToolName(name: string) {
  return OPENCODE_TO_CLAUDE_CODE_TOOL_NAME[name.toLowerCase()] ?? name;
}

function sanitizeSystemText(text: string) {
  return text.replaceAll(OPENCODE_IDENTITY, CLAUDE_CODE_IDENTITY);
}

function prependClaudeCodeIdentity(system: unknown) {
  const identityBlock = { type: "text", text: CLAUDE_CODE_IDENTITY };

  if (typeof system === "undefined") return [identityBlock];

  if (typeof system === "string") {
    const sanitized = sanitizeSystemText(system);
    if (sanitized === CLAUDE_CODE_IDENTITY) return [identityBlock];
    return [identityBlock, { type: "text", text: sanitized }];
  }

  if (!Array.isArray(system)) return [identityBlock, system];

  const sanitized = system.map((item) => {
    if (typeof item === "string") return { type: "text", text: sanitizeSystemText(item) };
    if (item && typeof item === "object" && (item as { type?: unknown }).type === "text") {
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string") {
        return { ...(item as Record<string, unknown>), text: sanitizeSystemText(text) };
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

function rewriteRequestPayload(body: string | undefined) {
  if (!body) return { body, modelId: undefined, reverseToolNameMap: new Map<string, string>() };

  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    const reverseToolNameMap = new Map<string, string>();
    const modelId = typeof payload.model === "string" ? payload.model : undefined;

    // Build reverse map and rename tools
    if (Array.isArray(payload.tools)) {
      payload.tools = payload.tools.map((tool) => {
        if (!tool || typeof tool !== "object") return tool;
        const name = (tool as { name?: unknown }).name;
        if (typeof name !== "string") return tool;
        const mapped = toClaudeCodeToolName(name);
        reverseToolNameMap.set(mapped, name);
        return { ...(tool as Record<string, unknown>), name: mapped };
      });
    }

    // Rename system prompt
    payload.system = prependClaudeCodeIdentity(payload.system);

    // Rename tool_choice
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

    // Rename tool_use blocks in messages
    if (Array.isArray(payload.messages)) {
      payload.messages = payload.messages.map((message) => {
        if (!message || typeof message !== "object") return message;
        const content = (message as { content?: unknown }).content;
        if (!Array.isArray(content)) return message;
        return {
          ...(message as Record<string, unknown>),
          content: content.map((block) => {
            if (!block || typeof block !== "object") return block;
            const b = block as { type?: unknown; name?: unknown };
            if (b.type !== "tool_use" || typeof b.name !== "string") return block;
            return { ...(block as Record<string, unknown>), name: toClaudeCodeToolName(b.name) };
          }),
        };
      });
    }

    return { body: JSON.stringify(payload), modelId, reverseToolNameMap };
  } catch {
    return { body, modelId: undefined, reverseToolNameMap: new Map<string, string>() };
  }
}

function wrapResponseStream(response: Response, reverseToolNameMap: Map<string, string>) {
  if (!response.body || reverseToolNameMap.size === 0) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let carry = "";

  const transform = (text: string) => {
    return text.replace(/"name"\s*:\s*"([^"]+)"/g, (full, name: string) => {
      const original = reverseToolNameMap.get(name);
      return original ? full.replace(`"${name}"`, `"${original}"`) : full;
    });
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        const finalText = carry + decoder.decode();
        if (finalText) controller.enqueue(encoder.encode(transform(finalText)));
        controller.close();
        return;
      }
      carry += decoder.decode(value, { stream: true });
      // Buffer 256 chars to avoid splitting JSON keys across chunks
      if (carry.length <= 256) return;
      const output = carry.slice(0, -256);
      carry = carry.slice(-256);
      controller.enqueue(encoder.encode(transform(output)));
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

// --- Beta headers ---

function getRequiredBetas(modelId: string | undefined) {
  const betas = [CLAUDE_CODE_BETA, OAUTH_BETA, FINE_GRAINED_TOOL_STREAMING_BETA];
  const isAdaptive =
    modelId?.includes("opus-4-6") ||
    modelId?.includes("opus-4.6") ||
    modelId?.includes("sonnet-4-6") ||
    modelId?.includes("sonnet-4.6");
  if (!isAdaptive) betas.push(INTERLEAVED_THINKING_BETA);
  return betas;
}

function mergeBetas(existing: string | null, required: string[]) {
  return [
    ...new Set([
      ...required,
      ...(existing || "").split(",").map((s) => s.trim()).filter(Boolean),
    ]),
  ].join(",");
}

// --- Token refresh with dedup ---

function isOAuthStored(auth: { type: string }): auth is OAuthStored {
  return auth.type === "oauth";
}

async function getFreshOAuth(
  getAuth: () => Promise<OAuthStored | { type: string }>,
  client: Parameters<Plugin>[0]["client"],
) {
  const auth = await getAuth();
  if (!isOAuthStored(auth)) return undefined;
  if (auth.access && auth.expires > Date.now()) return auth;

  if (!pendingRefresh) {
    pendingRefresh = withAuthRefreshLock(async () => {
      const latest = await getAuth();
      if (!isOAuthStored(latest)) {
        throw new Error("Anthropic OAuth credentials disappeared during refresh");
      }
      if (latest.access && latest.expires > Date.now()) return latest;

      const refreshed = await refreshAnthropicToken(latest.refresh);
      await client.auth.set({ path: { id: "anthropic" }, body: refreshed });
      return refreshed;
    }).finally(() => {
      pendingRefresh = undefined;
    });
  }

  return pendingRefresh;
}

// --- Plugin export ---

const AnthropicAuthPlugin: Plugin = async ({ client }) => {
  return {
    auth: {
      provider: "anthropic",
      async loader(
        getAuth: () => Promise<OAuthStored | { type: string }>,
        provider: { models: Record<string, { cost?: unknown }> },
      ) {
        const auth = await getAuth();
        if (auth.type !== "oauth") return {};

        // Zero out costs for OAuth users (Claude Pro/Max subscription)
        for (const model of Object.values(provider.models)) {
          model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
        }

        return {
          apiKey: "",
          async fetch(input: Request | string | URL, init?: RequestInit) {
            const url = (() => {
              try {
                return new URL(input instanceof Request ? input.url : input.toString());
              } catch {
                return null;
              }
            })();
            if (!url || !ANTHROPIC_HOSTS.has(url.hostname)) return fetch(input, init);

            const freshAuth = await getFreshOAuth(getAuth, client);
            if (!freshAuth) return fetch(input, init);

            const originalBody = typeof init?.body === "string"
              ? init.body
              : input instanceof Request
                ? await input.clone().text().catch(() => undefined)
                : undefined;

            const rewritten = rewriteRequestPayload(originalBody);
            const headers = new Headers(init?.headers);
            if (input instanceof Request) {
              input.headers.forEach((v, k) => { if (!headers.has(k)) headers.set(k, v); });
            }
            const betas = getRequiredBetas(rewritten.modelId);

            headers.set("accept", "application/json");
            headers.set("anthropic-beta", mergeBetas(headers.get("anthropic-beta"), betas));
            headers.set("anthropic-dangerous-direct-browser-access", "true");
            headers.set("authorization", `Bearer ${freshAuth.access}`);
            headers.set("user-agent", process.env.OPENCODE_ANTHROPIC_USER_AGENT || `claude-cli/${CLAUDE_CODE_VERSION}`);
            headers.set("x-app", "cli");
            headers.delete("x-api-key");

            const response = await fetch(input, {
              ...(init ?? {}),
              body: rewritten.body,
              headers,
            });

            return wrapResponseStream(response, rewritten.reverseToolNameMap);
          },
        };
      },
      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: buildAuthorizeHandler("oauth"),
        },
        {
          label: "Create an API Key",
          type: "oauth",
          authorize: buildAuthorizeHandler("apikey"),
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
