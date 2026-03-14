// App management for Fly Machines REST + GraphQL API.
// Types aligned with OpenAPI spec at https://docs.machines.dev/spec/openapi3.json

import { Client } from './client.ts'

export type ListAppRequest = string

/** Matches OpenAPI ListAppsResponse schema. */
export interface ListAppResponse {
  total_apps: number
  apps: AppInfo[]
}

/** Query params for GET /apps. org_slug is required, app_role is optional. */
export interface ListAppsParams {
  org_slug: string
  app_role?: string
}

export type GetAppRequest = string

const getAppQuery = `query($name: String!) {
  app(name: $name) {
      name
      status
      organization {
        name
        slug
      }
      ipAddresses {
        nodes {
          type
          region
          address
        }
      }
  }
}`

export enum AppStatus {
  deployed = 'deployed',
  pending = 'pending',
  suspended = 'suspended',
}

/** Matches OpenAPI AppOrganizationInfo schema. */
export interface AppOrganizationInfo {
  internal_numeric_id?: number
  name?: string
  slug?: string
}

/** Matches OpenAPI App schema — used in both GET /apps/{app_name} and ListAppsResponse. */
export interface AppInfo {
  id?: string
  internal_numeric_id?: number
  machine_count?: number
  name?: string
  network?: string
  organization?: AppOrganizationInfo
  status?: string
  volume_count?: number
}

/**
 * Full app response from GraphQL getAppDetailed.
 * Extends REST AppInfo with ipAddresses from the GraphQL query.
 */
export interface AppResponse {
  name: string
  status: AppStatus
  organization: {
    name: string
    slug: string
  }
  ipAddresses: IPAddress[]
}

export interface IPAddress {
  type: string
  address: string
}

/**
 * Matches OpenAPI CreateAppRequest schema.
 * Note: the spec uses `name` (not `app_name`) for the app name field.
 */
export interface CreateAppRequest {
  org_slug: string
  name: string
  network?: string
  enable_subdomains?: boolean
}

export type DeleteAppRequest = string

export class App {
  private client: Client

  constructor(client: Client) {
    this.client = client
  }

  async listApps(org_slug: ListAppRequest): Promise<ListAppResponse> {
    return await this.client.restOrThrow(`apps?org_slug=${org_slug}`)
  }

  /** List apps with full query params (org_slug + optional app_role filter). */
  async listAppsWithParams(params: ListAppsParams): Promise<ListAppResponse> {
    const query = new URLSearchParams({ org_slug: params.org_slug })
    if (params.app_role) {
      query.set('app_role', params.app_role)
    }
    return await this.client.restOrThrow(`apps?${query.toString()}`)
  }

  async getApp(app_name: GetAppRequest): Promise<AppInfo> {
    return await this.client.restOrThrow(`apps/${app_name}`)
  }

  async getAppDetailed(app_name: GetAppRequest): Promise<AppResponse> {
    const { app } = (await this.client.gqlPostOrThrow({
      query: getAppQuery,
      variables: { name: app_name },
    })) as { app: AppResponse }

    const ipAddresses = app.ipAddresses as unknown as { nodes: IPAddress[] }

    return {
      ...app,
      ipAddresses: ipAddresses.nodes,
    }
  }

  async createApp(payload: CreateAppRequest): Promise<void> {
    await this.client.restOrThrow('apps', 'POST', payload)
  }

  async deleteApp(app_name: DeleteAppRequest): Promise<void> {
    await this.client.restOrThrow(`apps/${app_name}`, 'DELETE')
  }
}
