// Detects `. btw` suffix at the end of a Discord message, identical pattern
// to the queue suffix. When present the suffix is stripped and the remaining
// message is forked to a new btw thread via /btw.
//
// Supported forms:
// - punctuation + btw: ". btw", "! btw", ". btw.", "!btw."
// - btw as its own final line: "text\nbtw"
// Non-matches: "btw fix this" (start only), "hello btw" (no punctuation)

const BTW_SUFFIX_RE = /(?:[.!?,;:])\s*btw\.?\s*$|\n\s*btw\.?\s*$/i

export function extractBtwSuffix(
  content: string,
): { prompt: string; forceBtw: boolean } {
  if (!BTW_SUFFIX_RE.test(content)) {
    return { prompt: content, forceBtw: false }
  }
  return { prompt: content.replace(BTW_SUFFIX_RE, '').trimEnd(), forceBtw: true }
}
