// Detects the raw `btw ` Discord message shortcut used to fork a side-question
// thread without invoking the /btw slash command UI.

export function extractBtwPrefix(
  content: string,
): { prompt: string } | null {
  if (!content) {
    return null
  }

  const match = content.match(/^\s*btw\s+([\s\S]+)$/i)
  if (!match) {
    return null
  }

  const prompt = match[1]?.trim()
  if (!prompt) {
    return null
  }

  return { prompt }
}
