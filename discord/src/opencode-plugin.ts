// OpenCode plugin entry point for Kimaki Discord bot.
// Each export is treated as a separate plugin by OpenCode's plugin loader.
// CRITICAL: never export utility functions from this file — only plugin
// initializer functions. OpenCode calls every export as a plugin.
//
// Plugins are split into focused modules:
// - ipc-tools-plugin: file upload + action buttons (IPC-based Discord tools)
// - context-awareness-plugin: branch, pwd, memory, time gap injection
// - opencode-interrupt-plugin: interrupt queued messages at step boundaries
// - onboarding-tutorial-plugin: inject tutorial instructions for new users

export { ipcToolsPlugin } from './ipc-tools-plugin.js'
export { contextAwarenessPlugin } from './context-awareness-plugin.js'
export { interruptOpencodeSessionOnUserMessage } from './opencode-interrupt-plugin.js'
export { onboardingTutorialPlugin } from './onboarding-tutorial-plugin.js'
