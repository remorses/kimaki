# Changelog

## 0.1.0

1. **First release: Grok Bot as an OpenCode V2 provider.** Every bot and group of the connected account is a model, so a session can talk to a bot like the Grok Bot app does.

   ```jsonc
   // opencode.json
   {
     "plugins": [{ "package": "@kimaki/plugin-grok-bot" }],
     "model": "grok-bot/ghosthand-x-marketing",
     // a model only listed here becomes a new bot on its first turn
     "providers": { "grok-bot": { "models": { "researcher": { "name": "Market Researcher" } } } },
   }
   ```

   - **Model IDs** are bot names in kebab case. Two bots with the same name: the newer one gets the first 4 ID characters (`backlinks-5ad0`). A renamed bot keeps its old model ID as an alias.
   - **Login**: in `/connect`, pick **Grok Bot account (browser sign-in)** and approve with the Cursor account of your Grok Bot. Connect several accounts and switch between them. **Grok Bot desktop app** reuses the macOS app login instead.
   - **Replies** stream as text, and the bot's tool activity shows as finished tool calls.
   - **Cards** become readable text: questions, approvals, files, app connections, forms, secret requests and drafts. Reply with an option number, or `approve` / `always` / `deny`.
   - **Files the bot sends** are downloaded to `~/Downloads/grok-bot/<hash>/<name>` (or `GROK_BOT_DOWNLOAD_DIR`), and the reply shows the local path.
   - **Late messages** the bot wrote after the last turn show at the start of the next turn.
   - Titles and compaction are answered locally. Attachments are not sent yet.
