// OpenCode plugin entry point for @kimaki/opencode-plugin.
// Each export is treated as a separate plugin by OpenCode's plugin loader.
//
// Currently provides Anthropic OAuth authentication for Claude Pro/Max
// subscription users. Future exports will add more standalone features
// from kimaki that work without the Discord bot.
//
// Usage in opencode.json:
//   { "plugin": ["@kimaki/opencode-plugin"] }
//
// Features:
// - OAuth PKCE login flow for Claude Pro/Max subscriptions
// - Automatic token refresh with deduplication
// - System prompt rewriting (OpenCode → Claude Code identity)
// - Tool name mapping so Anthropic API recognizes OpenCode tools
// - Beta header injection (claude-code, oauth, streaming, thinking)
// - Multi-account store with automatic rotation on rate limits
// - Cost zeroing for OAuth users (subscription covers usage)
// - API key creation from OAuth access token
//
// The plugin stores credentials in ~/.local/share/opencode/auth.json
// and account rotation state in anthropic-oauth-accounts.json.
// No SQLite, no Discord bot, no extra infrastructure required.
//
// Dedup guard: when running inside kimaki (KIMAKI=1 env var), these plugins
// are already loaded by kimaki's own plugin entry point. OpenCode's server
// plugin loader has no ID-based dedup (unlike TUI plugins), so without this
// guard both instances would register, causing double auth providers, double
// system prompt transforms, and double response stream wrapping.

import {
  anthropicAuthPlugin as _anthropicAuthPlugin,
  replacer as _replacer,
} from 'kimaki/anthropic-auth-plugin'

type PluginFn = (...args: unknown[]) => Promise<Record<string, unknown>>

const anthropicAuthPlugin: PluginFn = async (...args) => {
  if (process.env.KIMAKI) return {}
  return _anthropicAuthPlugin(...args)
}

const replacer: PluginFn = async (...args) => {
  if (process.env.KIMAKI) return {}
  return _replacer(...args)
}

export { anthropicAuthPlugin, replacer }
