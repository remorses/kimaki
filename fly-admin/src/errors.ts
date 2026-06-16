// Typed Fly API error classes and HTTP/GraphQL error mapping helpers.

import * as errore from 'errore'

import type { MainStatusCode } from './types.ts'

export class FlyApiError extends errore.createTaggedError({
  name: 'FlyApiError',
  message: 'Fly API request failed for $method $path with status $httpStatus',
}) {}

export class FlyBadRequestError extends errore.createTaggedError({
  name: 'FlyBadRequestError',
  message: 'Fly API returned 400 for $method $path',
}) {}

export class FlyUnauthorizedError extends errore.createTaggedError({
  name: 'FlyUnauthorizedError',
  message: 'Fly API returned 401 for $method $path',
}) {}

export class FlyNotFoundError extends errore.createTaggedError({
  name: 'FlyNotFoundError',
  message: 'Fly API returned 404 for $method $path',
}) {}

export class FlyPreconditionFailedError extends errore.createTaggedError({
  name: 'FlyPreconditionFailedError',
  message: 'Fly API returned 412 for $method $path',
}) {}

export class FlyUnprocessableEntityError extends errore.createTaggedError({
  name: 'FlyUnprocessableEntityError',
  message: 'Fly API returned 422 for $method $path',
}) {}

export class FlyInternalServerError extends errore.createTaggedError({
  name: 'FlyInternalServerError',
  message: 'Fly API returned 500 for $method $path',
}) {}

export class FlyGraphQLError extends errore.createTaggedError({
  name: 'FlyGraphQLError',
  message: 'Fly GraphQL request failed for $path: $messages',
}) {}

export type FlyClientError =
  | FlyApiError
  | FlyBadRequestError
  | FlyUnauthorizedError
  | FlyNotFoundError
  | FlyPreconditionFailedError
  | FlyUnprocessableEntityError
  | FlyInternalServerError
  | FlyGraphQLError

export type FlyResult<T> = FlyClientError | T

type ErrorResponsePayload = {
  details?: Record<string, unknown>
  error?: string
  status?: MainStatusCode
}

export function parseErrorResponsePayload({
  payload,
}: {
  payload: unknown
}): ErrorResponsePayload | null {
  if (!isObject(payload)) {
    return null
  }

  const details = isObject(payload.details) ? payload.details : undefined
  const error = typeof payload.error === 'string' ? payload.error : undefined
  const status = isMainStatusCode(payload.status) ? payload.status : undefined

  return { details, error, status }
}

export function createFlyHttpError({
  method,
  path,
  httpStatus,
  payload,
}: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  httpStatus: number
  payload: unknown
}): FlyClientError {
  parseErrorResponsePayload({ payload })

  if (httpStatus === 400) {
    return new FlyBadRequestError({ method, path })
  }
  if (httpStatus === 401) {
    return new FlyUnauthorizedError({ method, path })
  }
  if (httpStatus === 404) {
    return new FlyNotFoundError({ method, path })
  }
  if (httpStatus === 412) {
    return new FlyPreconditionFailedError({ method, path })
  }
  if (httpStatus === 422) {
    return new FlyUnprocessableEntityError({ method, path })
  }
  if (httpStatus === 500) {
    return new FlyInternalServerError({ method, path })
  }

  return new FlyApiError({ method, path, httpStatus })
}

export function createFlyGraphQLError({
  path,
  messages,
}: {
  path: string
  messages: string[]
}): FlyGraphQLError {
  return new FlyGraphQLError({
    path,
    messages: messages.join('; '),
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isMainStatusCode(value: unknown): value is MainStatusCode {
  return value === 'unknown' || value === 'insufficient_capacity'
}
