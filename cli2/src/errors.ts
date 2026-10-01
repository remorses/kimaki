// Tagged errors shared across cli2 modules (errore convention: return, don't throw).

import * as errore from 'errore'

export class OpenCodeError extends errore.createTaggedError({
  name: 'OpenCodeError',
  message: 'OpenCode $operation failed',
}) {}

export class OpenCodeUnavailableError extends errore.createTaggedError({
  name: 'OpenCodeUnavailableError',
  message: 'OpenCode service not reachable ($reason). Install OpenCode 2 with: npm i -g @opencode/cli',
}) {}

export class OpenCodeVersionError extends errore.createTaggedError({
  name: 'OpenCodeVersionError',
  message: 'OpenCode $version is older than the minimum $minimum. Run: opencode upgrade',
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

export class FilesystemError extends errore.createTaggedError({
  name: 'FilesystemError',
  message: 'Filesystem $operation failed',
}) {}
