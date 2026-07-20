# Changelog

## 0.1.0

1. **Initial release** — standalone OpenCode plugin for Claude Pro/Max subscription support via Anthropic OAuth. No Discord bot required.

   ```json
   { "plugin": ["@kimaki/opencode-plugin"] }
   ```

   Features:
   - OAuth PKCE login flow for Claude Pro/Max subscriptions
   - Automatic token refresh with deduplication
   - System prompt rewriting (OpenCode identity to Claude Code identity)
   - Tool name mapping so Anthropic API recognizes OpenCode tools
   - Beta header injection
   - Multi-account store with automatic rotation on rate limits
   - Cost zeroing for OAuth users (subscription covers usage)

   Credentials are stored in `~/.local/share/opencode/auth.json`. When running inside kimaki (`KIMAKI=1` env var), the plugin deactivates to avoid duplicate auth providers.
