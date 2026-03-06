// Sentry error tracking initialization and notifyError helper.
// Uses @sentry/node for the Node.js runtime (bot process, plugin process, worker threads).
// Must be initialized early in both the bot process (cli.ts) and plugin process
// (opencode-plugin.ts). The plugin process receives the DSN via KIMAKI_SENTRY_DSN env var.

import * as Sentry from '@sentry/node'
import * as errore from 'errore'
import { createRequire } from 'node:module'
import { sanitizeSensitiveText, sanitizeUnknownValue } from './privacy-sanitizer.js'

// DSN placeholder — replace with your Sentry project DSN.
// Users can also set KIMAKI_SENTRY_DSN env var.
const HARDCODED_DSN = 'https://3b87e21ac01cb9c66225719ea65111d2@o4510952031715328.ingest.us.sentry.io/4510952088469504'

function readKimakiVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('../package.json') as { version?: string }
    const version = pkg.version
    if (!version) {
      return 'unknown'
    }
    return version
  } catch {
    return 'unknown'
  }
}

const kimakiVersion = readKimakiVersion()
const kimakiRelease = `kimaki@${kimakiVersion}`

let initialized = false

/**
 * Initialize Sentry. Call once at process startup.
 * No-op if DSN is empty or --no-sentry was passed.
 */
export function initSentry({ dsn }: { dsn?: string } = {}): void {
  if (process.env.KIMAKI_SENTRY_DISABLED === '1') {
    return
  }

  const resolvedDsn = dsn || process.env.KIMAKI_SENTRY_DSN || HARDCODED_DSN
  if (!resolvedDsn || initialized) {
    return
  }

  Sentry.init({
    dsn: resolvedDsn,
    release: kimakiRelease,
    integrations: [],
    tracesSampleRate: 0,
    sendDefaultPii: false,
    profilesSampleRate: 0,
    beforeSend(event, hint) {
      // Skip in development — too noisy, errors appear in terminal
      if (process.env.NODE_ENV === 'development') {
        return null
      }
      // Skip abort errors — walks the cause chain so wrapped aborts are caught
      if (errore.isAbortError(hint.originalException)) {
        return null
      }

      try {
        const sanitizedEvent = sanitizeUnknownValue(event, {
          redactPaths: false,
        })
        if (sanitizedEvent && typeof sanitizedEvent === 'object') {
          return sanitizedEvent as typeof event
        }
      } catch {
        return event
      }
      return event
    },
  })

  Sentry.setTag('kimaki_version', kimakiVersion)

  initialized = true
}

/**
 * Report an unexpected error to Sentry.
 * Safe to call even if Sentry is not initialized.
 * Fire-and-forget only: use `void notifyError(error, msg)` and never await it.
 * This helper must never throw.
 * Use this at terminal error handlers — the "last catch" in a chain
 * where the error would otherwise be invisible.
 */
export function notifyError(error: unknown, msg?: string): void {
  try {
    if (!initialized) {
      return
    }

    // TODO re enable sentry?
    if (!process.env.KIMAKI_SENTRY) return
    const safeMsg = (() => {
      if (!msg) {
        return undefined
      }
      try {
        return sanitizeSensitiveText(msg, { redactPaths: false })
      } catch {
        return msg
      }
    })()
    const safeError = (() => {
      try {
        return sanitizeUnknownValue(error, { redactPaths: false })
      } catch {
        return error
      }
    })()

    Sentry.captureException(error, {
      tags: { kimaki_version: kimakiVersion },
      extra: { msg: safeMsg, kimakiVersion, error: safeError },
    })
    void Sentry.flush(1000).catch(() => {
      return
    })
  } catch {
    return
  }
}

/**
 * User-readable error class. Messages from AppError instances
 * are forwarded to the user as-is; regular Error messages may be obfuscated.
 */
export class AppError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppError'
  }
}
