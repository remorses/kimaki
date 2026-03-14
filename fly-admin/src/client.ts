// HTTP client for Fly.io Machines REST API and GraphQL API.
// Uses native fetch (no cross-fetch dependency).
// Vendored from supabase/fly-admin with modifications.

import * as errore from 'errore'

import { App } from './app.ts'
import {
  createFlyGraphQLError,
  createFlyHttpError,
  FlyApiError,
  type FlyClientError,
  type FlyResult,
} from './errors.ts'
import { Machine } from './machine.ts'
import { Network } from './network.ts'
import { Organization } from './organization.ts'
import { Regions } from './regions.ts'
import { Secret } from './secret.ts'
import { Token } from './token.ts'
import { Volume } from './volume.ts'

export const FLY_API_GRAPHQL = 'https://api.fly.io'
export const FLY_API_HOSTNAME = 'https://api.machines.dev'

interface GraphQLRequest<T> {
  query: string
  variables?: Record<string, T>
}

interface GraphQLResponse<T> {
  data: T
  errors?: {
    message: string
    locations: { line: number; column: number }[]
  }[]
}

export interface ClientConfig {
  graphqlUrl?: string
  apiUrl?: string
}

export class Client {
  private graphqlUrl: string
  private apiUrl: string
  private apiKey: string
  App: App
  Machine: Machine
  Regions: Regions
  Network: Network
  Organization: Organization
  Secret: Secret
  Volume: Volume
  Token: Token

  constructor(apiKey: string, { graphqlUrl, apiUrl }: ClientConfig = {}) {
    if (!apiKey) {
      throw new Error('Fly API Key is required')
    }
    this.graphqlUrl = graphqlUrl || FLY_API_GRAPHQL
    this.apiUrl = apiUrl || FLY_API_HOSTNAME
    this.apiKey = apiKey
    this.App = new App(this)
    this.Machine = new Machine(this)
    this.Network = new Network(this)
    this.Regions = new Regions(this)
    this.Organization = new Organization(this)
    this.Secret = new Secret(this)
    this.Volume = new Volume(this)
    this.Token = new Token(this)
  }

  getApiKey(): string {
    return this.apiKey
  }

  getApiUrl(): string {
    return this.apiUrl
  }

  getGraphqlUrl(): string {
    return this.graphqlUrl
  }

  async gqlPost<U, V>(payload: GraphQLRequest<U>): Promise<FlyClientError | V> {
    const path = 'graphql'
    const response = await fetch(`${this.graphqlUrl}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }).catch((cause: unknown) => {
      return new FlyApiError({
        method: 'POST',
        path,
        httpStatus: 0,
        cause,
      })
    })

    if (response instanceof Error) {
      return response
    }

    const responseText = await response.text().catch((cause: unknown) => {
      return new FlyApiError({
        method: 'POST',
        path,
        httpStatus: response.status,
        cause,
      })
    })

    if (responseText instanceof Error) {
      return responseText
    }

    if (!response.ok) {
      const payloadOrError = parseJson({ text: responseText })
      if (payloadOrError instanceof Error) {
        return new FlyApiError({
          method: 'POST',
          path,
          httpStatus: response.status,
          cause: payloadOrError,
        })
      }
      return createFlyHttpError({
        method: 'POST',
        path,
        httpStatus: response.status,
        payload: payloadOrError,
      })
    }

    const payloadOrError = parseJson({ text: responseText })
    if (payloadOrError instanceof Error) {
      return new FlyApiError({
        method: 'POST',
        path,
        httpStatus: response.status,
        cause: payloadOrError,
      })
    }

    const parsed = payloadOrError as GraphQLResponse<V>
    const { data, errors } = parsed
    if (errors) {
      return createFlyGraphQLError({
        path,
        messages: errors.map((error) => {
          return error.message
        }),
      })
    }

    return data
  }

  async gqlPostOrThrow<U, V>(payload: GraphQLRequest<U>): Promise<FlyResult<V>> {
    return await this.gqlPost<U, V>(payload)
  }

  async rest<V>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<FlyClientError | V> {
    const response = await fetch(`${this.apiUrl}/v1/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).catch((cause: unknown) => {
      return new FlyApiError({
        method,
        path,
        httpStatus: 0,
        cause,
      })
    })

    if (response instanceof Error) {
      return response
    }

    const responseText = await response.text().catch((cause: unknown) => {
      return new FlyApiError({
        method,
        path,
        httpStatus: response.status,
        cause,
      })
    })

    if (responseText instanceof Error) {
      return responseText
    }

    if (!response.ok) {
      const payloadOrError = parseJson({ text: responseText })
      if (payloadOrError instanceof Error) {
        return new FlyApiError({
          method,
          path,
          httpStatus: response.status,
          cause: payloadOrError,
        })
      }

      return createFlyHttpError({
        method,
        path,
        httpStatus: response.status,
        payload: payloadOrError,
      })
    }

    if (!responseText) {
      return undefined as V
    }

    const payloadOrError = parseJson({ text: responseText })
    if (payloadOrError instanceof Error) {
      return new FlyApiError({
        method,
        path,
        httpStatus: response.status,
        cause: payloadOrError,
      })
    }

    return payloadOrError as V
  }

  async restOrThrow<V>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<FlyResult<V>> {
    return await this.rest(path, method, body, headers)
  }
}

function parseJson({ text }: { text: string }): Error | unknown {
  return errore.try({
    try: () => {
      return JSON.parse(text) as unknown
    },
    catch: (cause) => {
      return new Error('Failed to parse JSON response', { cause })
    },
  })
}
