// Prints a compact one-line-per-event view of recorded OpenCode V2 event fixtures.
// Run: bun docs/opencode-v2-events/summarize-events.ts docs/opencode-v2-events/tools.events.jsonl
import fs from 'node:fs'

const skip = new Set(['session.text.delta', 'session.reasoning.delta', 'session.tool.input.delta', 'session.usage.updated', 'skill.updated'])
for (const file of process.argv.slice(2)) {
  console.log(`##### ${file}`)
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const { event } = JSON.parse(line)
    if (skip.has(event.type)) continue
    const { sessionID = '', assistantMessageID: _a, providerState: _p, state: _s, ...rest } = event.data ?? {}
    console.log(`${String(sessionID).slice(-6).padEnd(6)} ${event.type.padEnd(34)} ${JSON.stringify(rest).slice(0, 200)}`)
  }
}
