// Sensitive data redaction helpers for logs and telemetry payloads.
// Redacts common secrets, identifiers, emails, and can optionally redact paths.

const CORE_SENSITIVE_REPLACEMENTS: Array<{
  pattern: RegExp
  replacement: string
}> = [
  {
    pattern: /\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi,
    replacement: 'Bearer [REDACTED]',
  },
  {
    pattern: /\bsk-[A-Za-z0-9]{16,}\b/g,
    replacement: '[REDACTED_OPENAI_KEY]',
  },
  {
    pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g,
    replacement: '[REDACTED_GOOGLE_KEY]',
  },
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED_GITHUB_TOKEN]',
  },
  {
    pattern:
      /([?&](?:token|api[_-]?key|key|secret|password|authorization)=)[^&\s]+/gi,
    replacement: '$1[REDACTED]',
  },
  {
    pattern:
      /(\b(?:token|api[_-]?key|secret|password|authorization)\b\s*[:=]\s*")([^"]+)(")/gi,
    replacement: '$1[REDACTED]$3',
  },
  {
    pattern:
      /(\b(?:token|api[_-]?key|secret|password|authorization)\b\s*[:=]\s*)([^\s,;]+)/gi,
    replacement: '$1[REDACTED]',
  },
]

const PATH_REPLACEMENTS: Array<{
  pattern: RegExp
  replacement: string
}> = [
  {
    pattern: /\/(?:Users|home)\/[^/\s]+\/[^\s'"`)]*/g,
    replacement: '[REDACTED_PATH]',
  },
  {
    pattern: /[A-Za-z]:\\[^\s'"`)]*/g,
    replacement: '[REDACTED_PATH]',
  },
]

export function sanitizeSensitiveText(
  value: string,
  { redactPaths = false }: { redactPaths?: boolean } = {},
): string {
  const replacements = redactPaths
    ? [...CORE_SENSITIVE_REPLACEMENTS, ...PATH_REPLACEMENTS]
    : CORE_SENSITIVE_REPLACEMENTS
  return replacements.reduce((current, entry) => {
    return current.replace(entry.pattern, entry.replacement)
  }, value)
}

export function sanitizeUnknownValue(
  value: unknown,
  {
    depth = 0,
    seen = new WeakSet<object>(),
    redactPaths = false,
  }: {
    depth?: number
    seen?: WeakSet<object>
    redactPaths?: boolean
  } = {},
): unknown {
  if (depth > 8) {
    return '[REDACTED_DEPTH_LIMIT]'
  }

  if (typeof value === 'string') {
    return sanitizeSensitiveText(value, { redactPaths })
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  ) {
    return value
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (value instanceof Error) {
    const sanitizedStack = value.stack
      ? sanitizeSensitiveText(value.stack, { redactPaths })
      : undefined
    return {
      name: value.name,
      message: sanitizeSensitiveText(value.message, { redactPaths }),
      stack: sanitizedStack,
      cause: sanitizeUnknownValue(value.cause, {
        depth: depth + 1,
        seen,
        redactPaths,
      }),
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      return sanitizeUnknownValue(item, { depth: depth + 1, seen, redactPaths })
    })
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[REDACTED_CIRCULAR]'
    }
    seen.add(value)

    const sanitizedEntries = Object.entries(value).map(([key, entryValue]) => {
      return [
        key,
        sanitizeUnknownValue(entryValue, {
          depth: depth + 1,
          seen,
          redactPaths,
        }),
      ]
    })
    return Object.fromEntries(sanitizedEntries)
  }

  return sanitizeSensitiveText(String(value), { redactPaths })
}
