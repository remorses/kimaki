// Detect ". queue" at the end of a Discord message. Same forms as v1.

const QUEUE_SUFFIX_RE = /(?:[.!?,;:]|^)\s*queue\.?\s*$|\n\s*queue\.?\s*$/i

export function extractQueueSuffix(prompt: string) {
  if (!QUEUE_SUFFIX_RE.test(prompt)) {
    return { prompt, forceQueue: false }
  }
  return { prompt: prompt.replace(QUEUE_SUFFIX_RE, '').trimEnd(), forceQueue: true }
}
