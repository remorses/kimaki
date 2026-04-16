// OpenCode plugin entry point for Kimaki Discord bot.
// Each export is treated as a separate plugin by OpenCode's plugin loader.
// CRITICAL: never export utility functions from this file — only plugin
// initializer functions. OpenCode calls every export as a plugin.
//
// Plugins are split into focused modules:
// - ipc-tools-plugin: file upload + action buttons (IPC-based Discord tools)
// - context-awareness-plugin: branch, pwd, memory reminder, onboarding tutorial
// - memory-overview-plugin: frozen MEMORY.md heading overview per session
// - opencode-interrupt-plugin: interrupt queued messages at step boundaries
// - subagent-rate-limit-plugin: switches only task subagents after rate limits
// - kitty-graphics-plugin: extract Kitty Graphics Protocol images from bash output

export { ipcToolsPlugin } from './ipc-tools-plugin.js'
export { contextAwarenessPlugin } from './context-awareness-plugin.js'
export { memoryOverviewPlugin } from './memory-overview-plugin.js'
export { interruptOpencodeSessionOnUserMessage } from './opencode-interrupt-plugin.js'
export { systemPromptDriftPlugin } from './system-prompt-drift-plugin.js'
export { anthropicAuthPlugin } from './anthropic-auth-plugin.js'
export { imageOptimizerPlugin } from './image-optimizer-plugin.js'
export { subagentRateLimitPlugin } from './subagent-rate-limit-plugin.js'
export { kittyGraphicsPlugin } from 'kitty-graphics-agent'
export { injectionGuardInternal as injectionGuard } from 'opencode-injection-guard'
