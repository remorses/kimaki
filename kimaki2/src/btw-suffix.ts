// Detect ". btw" at the end of a Discord message. Same forms as v1.

const BTW_SUFFIX_RE = /(?:[.!?,;:])\s*btw\.?\s*$|\n\s*btw\.?\s*$/i

export function extractBtwSuffix(content: string) {
  if (!BTW_SUFFIX_RE.test(content)) {
    return { prompt: content, forceBtw: false }
  }
  return { prompt: content.replace(BTW_SUFFIX_RE, '').trimEnd(), forceBtw: true }
}
