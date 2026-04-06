// Centralized zustand/vanilla store for global bot state.
// Replaces scattered module-level `let` variables, process.env mutations,
// and mutable arrays with a single immutable state atom.
// See cli/skills/zustand-centralized-state/SKILL.md for the pattern.

import { createStore } from 'zustand/vanilla'
import type { VerbosityLevel } from './generated/client.js'
import type { ThreadRunState } from './session-handler/thread-runtime-state.js'

// Registered user commands, populated by registerCommands() in cli.ts.
// discordCommandName is the full sanitized Discord slash command name
// (including -cmd or -skill suffix), while name is the original OpenCode
// command name (may contain :, /, etc).
export type RegisteredUserCommand = {
  name: string
  discordCommandName: string
  description: string
  source?: 'command' | 'mcp' | 'skill'
}

// Deterministic transcription config for e2e tests.
// When set, processVoiceAttachment() skips the real AI model call and
// returns this canned result after sleeping for delayMs. This lets tests
// control transcription output, timing, and queue behavior deterministically.
export type DeterministicTranscriptionConfig = {
  transcription: string
  queueMessage: boolean
  /** Agent name extracted from voice message. Only set if user explicitly requested an agent. */
  agent?: string
  /** Artificial delay before returning the result (ms). Default 0. */
  delayMs?: number
}

export type KimakiState = {
  // ── Config state (set once at CLI startup, read everywhere) ──────────

  // Path to the kimaki data directory (default ~/.kimaki).
  // Changes: set once at startup by setDataDir() or auto-created on first
  // getDataDir() call. Under vitest, auto-creates a temp dir.
  // Read by: database paths, heap snapshot dir, log file path, hrana server.
  dataDir: string | null

  // Custom projects directory override (default: <dataDir>/projects).
  // When set via --projects-dir CLI flag, project create commands will
  // create new project folders here instead of ~/.kimaki/projects/.
  // Changes: set once at startup from --projects-dir CLI flag.
  // Read by: config.ts getProjectsDir().
  projectsDir: string | null

  // Default output verbosity for sessions when no channel-level override
  // exists in the DB. Controls which tool outputs are shown in Discord.
  // Changes: set once at startup from --verbosity CLI flag.
  // Read by: database.ts (fallback in getChannelVerbosity), message formatting.
  defaultVerbosity: VerbosityLevel

  // When true, the bot only responds to messages that @mention it in text
  // channels (threads are unaffected). Fallback when no channel override in DB.
  // Changes: set once at startup from --mention-mode CLI flag.
  // Read by: database.ts (fallback in getChannelMentionMode), discord-bot.ts guard.
  defaultMentionMode: boolean

  // Whether critique.work diff URL generation is enabled. When false,
  // the system message omits critique instructions from the AI context.
  // Changes: set once at startup from --no-critique CLI flag.
  // Read by: system-message.ts (conditionally appends critique instructions).
  critiqueEnabled: boolean

  // When true, adds --print-logs --log-level DEBUG to the opencode serve
  // args and forwards stdout/stderr to kimaki.log after server is ready.
  // Changes: set once at startup from --verbose-opencode-server CLI flag.
  // Read by: opencode.ts (spawn args and log forwarding).
  verboseOpencodeServer: boolean

  // Base URL for Discord REST API calls (default https://discord.com).
  // Overridden when using a gateway-proxy or gateway Discord mode.
  // Changes: set by getBotTokenWithMode() which runs at startup and on
  // multiple runtime paths (CLI init, opencode spawn). May be updated
  // whenever bot credentials are re-read from the DB.
  // Read by: discord-urls.ts (getDiscordRestApiUrl), REST client construction.
  discordBaseUrl: string

  // Service auth token (client_id:client_secret) used to authenticate
  // control-plane requests like /kimaki/wake. Always set at startup in all
  // modes so localhost and internet paths share one auth model.
  // Changes: set in cli.ts after credential resolution and persisted in sqlite.
  // Read by: hrana-server.ts to validate Authorization bearer token.
  gatewayToken: string | null

  // User-defined slash commands registered with Discord, populated after
  // registerCommands() completes during startup. Maps sanitized Discord
  // command names back to original OpenCode command names.
  // Changes: set once during startup after Discord API registration.
  // Read by: /queue-command autocomplete, user-command handler dispatch.
  registeredUserCommands: RegisteredUserCommand[]

  // ── Per-thread runtime state ────────────────────────────────────────
  // The main mutable state at runtime. One ThreadRunState per active thread.
  // All mutations are immutable: each updateThread() creates a new Map + new
  // ThreadRunState object via store.setState(). See thread-runtime-state.ts.
  // Changes: on every message enqueue, prompt dispatch, phase transition,
  // abort, and finish.
  // Read by: runtime state helpers (isRunActive, canDispatchNext), session
  // orchestration in ThreadSessionRuntime, /abort and /queue via runtime APIs.
  threads: Map<string, ThreadRunState>

  // ── Test-only state ─────────────────────────────────────────────────
  test: {
    // When set, processVoiceAttachment() skips the real AI transcription
    // call and returns this canned result after sleeping delayMs.
    // Lets e2e tests control transcription output and timing.
    // Changes: set/cleared by e2e test setup/teardown only.
    // Read by: voice-handler.ts processVoiceAttachment().
    deterministicTranscription: DeterministicTranscriptionConfig | null
  }
}

export const store = createStore<KimakiState>(() => ({
  dataDir: null,
  projectsDir: null,
  defaultVerbosity: 'text_and_essential_tools',
  defaultMentionMode: false,
  critiqueEnabled: true,
  verboseOpencodeServer: false,
  discordBaseUrl: 'https://discord.com',
  gatewayToken: null,
  registeredUserCommands: [],
  threads: new Map(),
  test: { deterministicTranscription: null },
}))
