// Tagged errors shared across kimaki modules (errore convention: return, don't throw).

import * as errore from 'errore'

export class OpenCodeError extends errore.createTaggedError({
  name: 'OpenCodeError',
  message: 'OpenCode $operation failed',
}) {}

export class OpenCodeUnavailableError extends errore.createTaggedError({
  name: 'OpenCodeUnavailableError',
  message: 'OpenCode service not reachable ($reason)',
}) {}

export class OpenCodeMissingError extends errore.createTaggedError({
  name: 'OpenCodeMissingError',
  message: 'Kimaki requires OpenCode 2, which is not installed. Install it with: $install (or: npm i -g @opencode/cli). Then run kimaki again',
}) {}

// Both install commands put OpenCode 2 at `opencode` and `opencode2`.
export class OpenCodeV1Error extends errore.createTaggedError({
  name: 'OpenCodeV1Error',
  message: 'Kimaki now requires OpenCode 2, but $binary is OpenCode $version. Install OpenCode 2 with: $install (or: npm i -g @opencode/cli). Then run kimaki again',
}) {}

export class OpenCodeVersionError extends errore.createTaggedError({
  name: 'OpenCodeVersionError',
  message: 'OpenCode $version is older than the minimum $minimum. Run: opencode upgrade',
}) {}

// The CLI found no running bot (no lock token, or nothing answers on the lock port).
export class BotNotRunningError extends errore.createTaggedError({
  name: 'BotNotRunningError',
  message: 'Kimaki bot is not running. Start kimaki first.',
}) {}

export class DiscordError extends errore.createTaggedError({
  name: 'DiscordError',
  message: 'Discord $operation failed',
}) {}

export class DbError extends errore.createTaggedError({
  name: 'DbError',
  message: 'Database $operation failed',
}) {}

export class DbNotMigratedError extends errore.createTaggedError({
  name: 'DbNotMigratedError',
  message: 'Kimaki database is not set up ($missing is missing). Run kimaki once to set up the database',
}) {}

export class ConfigError extends errore.createTaggedError({
  name: 'ConfigError',
  message: '$reason',
}) {}

export class LockPortError extends errore.createTaggedError({
  name: 'LockPortError',
  message: 'Could not take lock port $port: $reason',
}) {}

export class CloudWakeSyncError extends errore.createTaggedError({
  name: 'CloudWakeSyncError',
  message: 'Cannot store the next wake time on kimaki.dev ($reason)',
}) {}

export class FilesystemError extends errore.createTaggedError({
  name: 'FilesystemError',
  message: 'Filesystem $operation failed',
}) {}
