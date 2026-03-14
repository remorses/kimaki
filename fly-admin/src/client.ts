// HTTP client for Fly.io Machines REST API and GraphQL API.
// Uses native fetch (no cross-fetch dependency).
// Vendored from supabase/fly-admin with modifications.

import { App } from './app.ts'
import { Machine } from './machine.ts'
import { Network } from './network.ts'
import { Organization } from './organization.ts'
import { Regions } from './regions.ts'
import { Secret } from './secret.ts'
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

  async gqlPostOrThrow<U, V>(payload: GraphQLRequest<U>): Promise<V> {
    const resp = await fetch(`${this.graphqlUrl}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    const text = await resp.text()
    if (!resp.ok) {
      throw new Error(`${resp.status}: ${text}`)
    }
    const { data, errors }: GraphQLResponse<V> = JSON.parse(text)
    if (errors) {
      throw new Error(JSON.stringify(errors))
    }
    return data
  }

  async restOrThrow<V>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<V> {
    const resp = await fetch(`${this.apiUrl}/v1/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await resp.text()
    if (!resp.ok) {
      throw new Error(`${resp.status}: ${text}`)
    }
    return text ? JSON.parse(text) : (undefined as V)
  }
}
