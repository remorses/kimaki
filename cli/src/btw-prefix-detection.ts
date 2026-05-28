// Detects the `. btw <prompt>` suffix pattern in Discord messages.
// Only triggers when "btw" is preceded by punctuation or a newline,
// similar to the queue suffix detection. This forks a side-question
// thread without invoking the /btw slash command UI.
//
// Examples: "fix the bug. btw check tests", "done!\nbtw also review auth"
// Non-matches: "btw fix this" (start of message), "hello btw fix" (no punctuation)

// Matches "btw" preceded by punctuation (.!?,;:) or newline, followed by
// separator (whitespace or punctuation) then the prompt content.
const BTW_SUFFIX_RE =
  /(?:[.!?,;:])\s*btw[.,;:!?\s]\s*([\s\S]+)$|\n\s*btw[.,;:!?\s]\s*([\s\S]+)$/i

export function extractBtwSuffix(
  content: string,
): { prompt: string; remaining: string } | null {
  if (!content) {
    return null
  }

  const match = content.match(BTW_SUFFIX_RE)
  if (!match) {
    return null
  }

  const prompt = (match[1] || match[2])?.trim()
  if (!prompt) {
    return null
  }

  // Everything before the matched suffix is the remaining message
  const remaining = content.slice(0, match.index!).trim()

  return { prompt, remaining }
}
