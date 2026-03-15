// Shared utilities for invoking the critique CLI and parsing its JSON output.
// Used by /diff command and footer diff link uploads.

import { execAsync } from './worktrees.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.DIFF)

const CRITIQUE_TIMEOUT_MS = 30_000

/**
 * Shell-quote a string by wrapping in single quotes and escaping embedded
 * single quotes. Prevents injection when interpolating into shell commands.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

export type CritiqueResult = {
  url: string
  id: string
  error?: undefined
} | {
  url?: undefined
  id?: undefined
  error: string
}

/**
 * Parse critique --json output. Critique prints progress to stderr and JSON
 * to stdout. The JSON line contains { url, id } on success or { error } on
 * failure. We scan all lines for the first valid JSON object with a url or
 * error field, falling back to searching for a critique.work URL in the raw
 * output.
 */
export function parseCritiqueOutput(output: string): CritiqueResult | undefined {
  const lines = output.trim().split('\n')
  for (const line of lines) {
    if (!line.startsWith('{')) {
      continue
    }
    try {
      const parsed = JSON.parse(line) as {
        url?: string
        id?: string
        error?: string
      }
      if (parsed.error) {
        return { error: parsed.error }
      }
      if (parsed.url && parsed.id) {
        return { url: parsed.url, id: parsed.id }
      }
    } catch {
      // not valid JSON, try next line
    }
  }
  // Fallback: try to find a URL in the raw output
  const urlMatch = output.match(/https?:\/\/critique\.work\/[^\s]+/)
  if (urlMatch) {
    const url = urlMatch[0]
    // Extract ID from URL path: /v/{id}
    const idMatch = url.match(/\/v\/([a-f0-9]+)/)
    const id = idMatch?.[1]
    if (id) {
      return { url, id }
    }
    // URL without parseable id — return as error so callers don't build
    // broken OG image URLs from an empty id
    return { error: url }
  }
  return undefined
}

/**
 * Run critique on the current git working tree diff and return the result.
 * Used by the /diff slash command.
 */
export async function uploadGitDiffViaCritique({
  title,
  cwd,
}: {
  title: string
  cwd: string
}): Promise<CritiqueResult | undefined> {
  try {
    const { stdout, stderr } = await execAsync(
      `critique --web ${shellQuote(title)} --json`,
      { cwd, timeout: CRITIQUE_TIMEOUT_MS },
    )
    return parseCritiqueOutput(stdout || stderr)
  } catch (error) {
    // exec error includes stdout/stderr — try to parse JSON from it
    const execError = error as {
      stdout?: string
      stderr?: string
      message?: string
    }
    const output = execError.stdout || execError.stderr || ''
    const parsed = parseCritiqueOutput(output)
    if (parsed) {
      return parsed
    }
    const message = execError.message || 'Unknown error'
    if (message.includes('command not found') || message.includes('ENOENT')) {
      return { error: 'critique not available' }
    }
    return { error: `Failed to generate diff: ${message.slice(0, 200)}` }
  }
}

/**
 * Upload a .patch file to critique.work via critique --stdin.
 * Returns the critique URL on success, undefined on failure.
 * Default timeout is 10s since this runs in the background (footer edit).
 */
export async function uploadPatchViaCritique({
  patchPath,
  title,
  cwd,
  timeoutMs = 10_000,
}: {
  patchPath: string
  title: string
  cwd: string
  timeoutMs?: number
}): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync(
      `critique --stdin --web ${shellQuote(title)} --json < ${shellQuote(patchPath)}`,
      { cwd, timeout: timeoutMs },
    )
    const result = parseCritiqueOutput(stdout)
    return result?.url
  } catch (error) {
    logger.error('critique upload failed:', error)
    return undefined
  }
}
