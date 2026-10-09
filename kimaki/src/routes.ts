// Input parsers: every Discord input becomes one Route (spec 9.4). Pure.
// Text messages, slash commands and voice transcriptions all produce the
// same shape, so dispatch never knows where a route came from.
//
//   "!pnpm test"            shell
//   "text. btw" / "\nbtw"   btw        (fork into a side thread)
//   "text. queue"           queue      (after the current run)
//   "/review args"          command    (if OpenCode knows the command)
//   anything else           steer      (interrupts the current run)

export type Route =
  // `agent`: a voice message asked for this agent (spec 9.4).
  | { kind: 'steer' | 'queue' | 'btw' | 'new-session'; text: string; agent?: string }
  | { kind: 'shell'; command: string }
  | { kind: 'command'; name: string; arguments: string; queue: boolean }
  // `/<skill>-skill args`: a prompt with the skill attached.
  | { kind: 'skill'; id: string; arguments: string }

const BTW_SUFFIX_RE = /(?:[.!?,;:])\s*btw\.?\s*$|\n\s*btw\.?\s*$/i
// "btw queue" forks at once: a queued fork is not native (spec 9.2).
const BTW_QUEUE_SUFFIX_RE = /(?:[.!?,;:])\s*btw\s+queue\.?\s*$|\n\s*btw\s+queue\.?\s*$/i
const QUEUE_SUFFIX_RE = /(?:[.!?,;:]|^)\s*queue\.?\s*$|\n\s*queue\.?\s*$/i
const COMMAND_RE = /^\/([\w.:-]+)(?:\s+([\s\S]*))?$/

export function stripQueueSuffix(text: string): { text: string; queue: boolean } {
  if (!QUEUE_SUFFIX_RE.test(text)) return { text, queue: false }
  return { text: text.replace(QUEUE_SUFFIX_RE, '').trimEnd(), queue: true }
}

export function parseTextMessage({ content }: { content: string }): Route | null {
  const text = content.trim()
  if (!text) return null
  if (text.startsWith('!')) {
    const command = text.slice(1).trim()
    return command ? { kind: 'shell', command } : null
  }
  for (const suffix of [BTW_QUEUE_SUFFIX_RE, BTW_SUFFIX_RE]) {
    if (suffix.test(text)) {
      const prompt = text.replace(suffix, '').trimEnd()
      return prompt ? { kind: 'btw', text: prompt } : null
    }
  }
  const queued = stripQueueSuffix(text)
  if (!queued.text) return null
  const command = queued.text.match(COMMAND_RE)
  if (command) return { kind: 'command', name: command[1]!, arguments: command[2]?.trim() ?? '', queue: queued.queue }
  return { kind: queued.queue ? 'queue' : 'steer', text: queued.text }
}
