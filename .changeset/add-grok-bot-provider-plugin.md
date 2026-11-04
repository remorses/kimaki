---
'@kimaki/plugin-grok-bot': minor
---

Add `@kimaki/plugin-grok-bot`, an OpenCode V2 plugin that makes Grok Bot a provider. Every bot and group of the connected account is a model, so a session can talk to a bot like the Grok Bot app does.

```jsonc
// opencode.json
{
  "plugins": [{ "package": "@kimaki/plugin-grok-bot" }],
  "model": "grok-bot/ghosthand-x-marketing",
  // a model only listed here becomes a new bot on its first turn
  "providers": { "grok-bot": { "models": { "researcher": { "name": "Market Researcher" } } } },
}
```

- **Model IDs** are bot names in kebab case. Two bots with the same name: the newer one gets the first 4 ID characters (`backlinks-5ad0`). A renamed bot keeps its old model ID as an alias, so a rename never creates a duplicate.

- **Login**: in `/connect`, pick **Grok Bot account (browser sign-in)** and approve with the Cursor account of your Grok Bot. Connect several accounts and switch between them; the models follow the active account. **Grok Bot desktop app** reuses the macOS app login instead (asks for Keychain access once).
- **Replies** stream as text, and the bot's tool activity ("is running shell commands", screenshots) shows as finished tool calls.
- **Cards** become readable text: questions list their options, approvals show the command, plus files, app connections, forms, secret requests and drafts. Reply with an option number, or `approve` / `always` / `deny`, to answer them from OpenCode.
- Titles and compaction are answered locally, because the bot keeps its own history. Attachments are not sent yet.
