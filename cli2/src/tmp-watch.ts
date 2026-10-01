import { resolveOpencode } from './opencode-server.ts'

const ep = await resolveOpencode({ ensure: false })
if (ep instanceof Error) throw ep
const ac = new AbortController()
setTimeout(() => ac.abort(), 25_000)
try {
  for await (const e of ep.client.event.subscribe({ signal: ac.signal })) {
    if (e.type === 'skill.updated' && e.location?.directory === '/Users/morse') console.log(new Date().toISOString(), 'EVENT skill.updated')
  }
} catch {}
