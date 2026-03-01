// Tagged errors for website route handlers.

import * as errore from 'errore'

export class StateDecodeError extends errore.createTaggedError({
  name: 'StateDecodeError',
  message: 'Failed to decode OAuth state parameter',
}) {}

export class InvalidStateFormatError extends errore.createTaggedError({
  name: 'InvalidStateFormatError',
  message: 'OAuth state parameter format is invalid',
}) {}

export class InvalidClientCredentialsError extends errore.createTaggedError({
  name: 'InvalidClientCredentialsError',
  message: 'OAuth client credentials format is invalid',
}) {}

export class GatewayClientUpsertError extends errore.createTaggedError({
  name: 'GatewayClientUpsertError',
  message: 'Failed to upsert gateway client $clientId for guild $guildId',
}) {}

export class GatewayClientLookupError extends errore.createTaggedError({
  name: 'GatewayClientLookupError',
  message: 'Failed to lookup gateway client $clientId',
}) {}

export class DiscordProxyFetchError extends errore.createTaggedError({
  name: 'DiscordProxyFetchError',
  message: 'Failed to proxy Discord request to $url',
}) {}

export class GatewayBotResponseDecodeError extends errore.createTaggedError({
  name: 'GatewayBotResponseDecodeError',
  message: 'Failed to decode gateway/bot payload from Discord',
}) {}
