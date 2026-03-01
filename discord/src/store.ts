// Centralized zustand/vanilla store for global bot state.
// Replaces scattered module-level `let` variables, process.env mutations,
// and mutable arrays with a single immutable state atom.
//
// Phase 1: config state (set once at CLI startup, read everywhere).
// Future phases will move session Maps, server registry, and command
// pending contexts into this store.
//
// See docs/zustand-state-centralization-plan.md for the full migration plan
// and discord/skills/zustand-centralized-state/SKILL.md for the pattern.

import { createStore } from 'zustand/vanilla'
import type { VerbosityLevel } from './database.js'

// Registered user commands, populated by registerCommands() in cli.ts.
// discordName is the sanitized Discord slash command name (without -cmd suffix),
// name is the original OpenCode command name (may contain :, /, etc).
export type RegisteredUserCommand = {
  name: string
  discordName: string
  description: string
}

export type KimakiState = {
  // ── Minimal config state (set once at startup by CLI) ──
  dataDir: string | null
  defaultVerbosity: VerbosityLevel
  defaultMentionMode: boolean
  critiqueEnabled: boolean
  verboseOpencodeServer: boolean
  discordBaseUrl: string
  registeredUserCommands: RegisteredUserCommand[]
}

export const store = createStore<KimakiState>(() => ({
  dataDir: null,
  defaultVerbosity: 'text-and-essential-tools',
  defaultMentionMode: false,
  critiqueEnabled: true,
  verboseOpencodeServer: false,
  discordBaseUrl: 'https://discord.com',
  registeredUserCommands: [],
}))
