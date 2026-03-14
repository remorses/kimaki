// App management for Fly Machines REST + GraphQL API.
// Types aligned with OpenAPI spec at https://docs.machines.dev/spec/openapi3.json

import { Client } from './client.ts'
import type { FlyResult } from './errors.ts'
import type {
  App as ApiApp,
  AppOrganizationInfo as ApiAppOrganizationInfo,
  AppSecret,
  AppSecrets,
  AppSecretsUpdateRequest,
  AppSecretsUpdateResp,
  CertificateCheckResponse,
  CertificateDetail,
  CreateAcmeCertificateRequest,
  CreateAppDeployTokenRequest,
  CreateAppResponse,
  CreateCustomCertificateRequest,
  DeleteAppSecretResponse,
  DeleteSecretkeyResponse,
  DecryptSecretkeyRequest,
  DecryptSecretkeyResponse,
  DestroyCustomCertificateResponse,
  EncryptSecretkeyRequest,
  EncryptSecretkeyResponse,
  IPAssignment,
  ListAppsResponse as ApiListAppsResponse,
  ListCertificatesResponse,
  ListIPAssignmentsResponse,
  SecretKey,
  SecretKeys,
  SetAppSecretRequest,
  SetAppSecretResponse,
  SetSecretkeyRequest,
  SetSecretkeyResponse,
  SignSecretkeyRequest,
  SignSecretkeyResponse,
  VerifySecretkeyRequest,
} from './types.ts'

export type ListAppRequest = string

/** Matches OpenAPI ListAppsResponse schema. */
export type ListAppResponse = ApiListAppsResponse

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
export type AppOrganizationInfo = ApiAppOrganizationInfo

/** Matches OpenAPI App schema — used in both GET /apps/{app_name} and ListAppsResponse. */
export type AppInfo = ApiApp

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
  region?: string
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

export interface ListCertificatesRequest {
  app_name: string
  filter?: string
  cursor?: string
  limit?: number
}

export interface RequestAcmeCertificateRequest {
  app_name: string
  request: CreateAcmeCertificateRequest
}

export interface RequestCustomCertificateRequest {
  app_name: string
  request: CreateCustomCertificateRequest
}

export interface CertificateRequest {
  app_name: string
  hostname: string
}

export interface CreateDeployTokenRequest {
  app_name: string
  request: CreateAppDeployTokenRequest
}

export interface ListSecretKeysRequest {
  app_name: string
  min_version?: string
  types?: string
}

export interface SecretKeyRequest {
  app_name: string
  secret_name: string
  min_version?: string
}

export interface SetSecretKeyRequest {
  app_name: string
  secret_name: string
  request: SetSecretkeyRequest
}

export interface SecretKeyDecryptRequest {
  app_name: string
  secret_name: string
  request: DecryptSecretkeyRequest
  min_version?: string
}

export interface SecretKeyEncryptRequest {
  app_name: string
  secret_name: string
  request: EncryptSecretkeyRequest
  min_version?: string
}

export interface SecretKeySignRequest {
  app_name: string
  secret_name: string
  request: SignSecretkeyRequest
  min_version?: string
}

export interface SecretKeyVerifyRequest {
  app_name: string
  secret_name: string
  request: VerifySecretkeyRequest
  min_version?: string
}

export interface ListSecretsRequest {
  app_name: string
  min_version?: string
  show_secrets?: boolean
}

export interface UpdateSecretsRequest {
  app_name: string
  request: AppSecretsUpdateRequest
}

export interface SecretRequest {
  app_name: string
  secret_name: string
  min_version?: string
  show_secrets?: boolean
}

export interface SetSecretRequest {
  app_name: string
  secret_name: string
  request: SetAppSecretRequest
}

export interface AssignIPAddressRequest {
  app_name: string
  request: {
    region?: string
    service_name?: string
    type?: string
  }
}

export interface DeleteIPAddressRequest {
  app_name: string
  ip: string
}

export class App {
  private client: Client

  constructor(client: Client) {
    this.client = client
  }

  async listApps(org_slug: ListAppRequest): Promise<FlyResult<ListAppResponse>> {
    return await this.client.restOrThrow(`apps?org_slug=${org_slug}`)
  }

  /** List apps with full query params (org_slug + optional app_role filter). */
  async listAppsWithParams(params: ListAppsParams): Promise<FlyResult<ListAppResponse>> {
    const query = new URLSearchParams({ org_slug: params.org_slug })
    if (params.app_role) {
      query.set('app_role', params.app_role)
    }
    return await this.client.restOrThrow(`apps?${query.toString()}`)
  }

  async getApp(app_name: GetAppRequest): Promise<FlyResult<AppInfo>> {
    return await this.client.restOrThrow(`apps/${app_name}`)
  }

  async getAppDetailed(app_name: GetAppRequest): Promise<FlyResult<AppResponse>> {
    const result = await this.client.gqlPostOrThrow<string, { app: AppResponse & { ipAddresses: { nodes: IPAddress[] } } }>({
      query: getAppQuery,
      variables: { name: app_name },
    })

    if (result instanceof Error) {
      return result
    }

    const { app } = result

    return {
      ...app,
      ipAddresses: app.ipAddresses.nodes,
    }
  }

  async createApp(payload: CreateAppRequest): Promise<FlyResult<void>> {
    return await this.client.restOrThrow('apps', 'POST', payload)
  }

  async deleteApp(app_name: DeleteAppRequest): Promise<FlyResult<void>> {
    return await this.client.restOrThrow(`apps/${app_name}`, 'DELETE')
  }

  async listCertificates(payload: ListCertificatesRequest): Promise<FlyResult<ListCertificatesResponse>> {
    const { app_name, filter, cursor, limit } = payload
    const params = new URLSearchParams()
    if (filter) {
      params.set('filter', filter)
    }
    if (cursor) {
      params.set('cursor', cursor)
    }
    if (limit !== undefined) {
      params.set('limit', String(limit))
    }
    const query = params.toString()
    const path = `apps/${app_name}/certificates${query ? `?${query}` : ''}`
    return await this.client.restOrThrow(path)
  }

  async requestAcmeCertificate(payload: RequestAcmeCertificateRequest): Promise<FlyResult<CertificateDetail>> {
    const { app_name, request } = payload
    return await this.client.restOrThrow(`apps/${app_name}/certificates/acme`, 'POST', request)
  }

  async requestCustomCertificate(payload: RequestCustomCertificateRequest): Promise<FlyResult<CertificateDetail>> {
    const { app_name, request } = payload
    return await this.client.restOrThrow(`apps/${app_name}/certificates/custom`, 'POST', request)
  }

  async getCertificate(payload: CertificateRequest): Promise<FlyResult<CertificateDetail>> {
    const { app_name, hostname } = payload
    return await this.client.restOrThrow(`apps/${app_name}/certificates/${hostname}`)
  }

  async deleteCertificate(payload: CertificateRequest): Promise<FlyResult<void>> {
    const { app_name, hostname } = payload
    return await this.client.restOrThrow(`apps/${app_name}/certificates/${hostname}`, 'DELETE')
  }

  async deleteAcmeCertificates(payload: CertificateRequest): Promise<FlyResult<CertificateDetail>> {
    const { app_name, hostname } = payload
    return await this.client.restOrThrow(`apps/${app_name}/certificates/${hostname}/acme`, 'DELETE')
  }

  async checkCertificate(payload: CertificateRequest): Promise<FlyResult<CertificateCheckResponse>> {
    const { app_name, hostname } = payload
    return await this.client.restOrThrow(`apps/${app_name}/certificates/${hostname}/check`, 'POST')
  }

  async deleteCustomCertificate(payload: CertificateRequest): Promise<FlyResult<DestroyCustomCertificateResponse>> {
    const { app_name, hostname } = payload
    return await this.client.restOrThrow(`apps/${app_name}/certificates/${hostname}/custom`, 'DELETE')
  }

  async createDeployToken(payload: CreateDeployTokenRequest): Promise<FlyResult<CreateAppResponse>> {
    const { app_name, request } = payload
    return await this.client.restOrThrow(`apps/${app_name}/deploy_token`, 'POST', request)
  }

  async listIpAssignments(app_name: string): Promise<FlyResult<ListIPAssignmentsResponse>> {
    return await this.client.restOrThrow(`apps/${app_name}/ip_assignments`)
  }

  async assignIpAddress(payload: AssignIPAddressRequest): Promise<FlyResult<IPAssignment>> {
    const { app_name, request } = payload
    return await this.client.restOrThrow(`apps/${app_name}/ip_assignments`, 'POST', request)
  }

  async deleteIpAssignment(payload: DeleteIPAddressRequest): Promise<FlyResult<void>> {
    const { app_name, ip } = payload
    return await this.client.restOrThrow(`apps/${app_name}/ip_assignments/${ip}`, 'DELETE')
  }

  async listSecretKeys(payload: ListSecretKeysRequest): Promise<FlyResult<SecretKeys>> {
    const { app_name, min_version, types } = payload
    const params = new URLSearchParams()
    if (min_version) {
      params.set('min_version', min_version)
    }
    if (types) {
      params.set('types', types)
    }
    const query = params.toString()
    const path = `apps/${app_name}/secretkeys${query ? `?${query}` : ''}`
    return await this.client.restOrThrow(path)
  }

  async getSecretKey(payload: SecretKeyRequest): Promise<FlyResult<SecretKey>> {
    const { app_name, secret_name, min_version } = payload
    const query = min_version ? `?min_version=${encodeURIComponent(min_version)}` : ''
    return await this.client.restOrThrow(`apps/${app_name}/secretkeys/${secret_name}${query}`)
  }

  async setSecretKey(payload: SetSecretKeyRequest): Promise<FlyResult<SetSecretkeyResponse>> {
    const { app_name, secret_name, request } = payload
    return await this.client.restOrThrow(`apps/${app_name}/secretkeys/${secret_name}`, 'POST', request)
  }

  async deleteSecretKey(payload: SecretKeyRequest): Promise<FlyResult<DeleteSecretkeyResponse>> {
    const { app_name, secret_name } = payload
    return await this.client.restOrThrow(`apps/${app_name}/secretkeys/${secret_name}`, 'DELETE')
  }

  async decryptSecretKey(payload: SecretKeyDecryptRequest): Promise<FlyResult<DecryptSecretkeyResponse>> {
    const { app_name, secret_name, request, min_version } = payload
    const query = min_version ? `?min_version=${encodeURIComponent(min_version)}` : ''
    return await this.client.restOrThrow(
      `apps/${app_name}/secretkeys/${secret_name}/decrypt${query}`,
      'POST',
      request,
    )
  }

  async encryptSecretKey(payload: SecretKeyEncryptRequest): Promise<FlyResult<EncryptSecretkeyResponse>> {
    const { app_name, secret_name, request, min_version } = payload
    const query = min_version ? `?min_version=${encodeURIComponent(min_version)}` : ''
    return await this.client.restOrThrow(
      `apps/${app_name}/secretkeys/${secret_name}/encrypt${query}`,
      'POST',
      request,
    )
  }

  async generateSecretKey(payload: SetSecretKeyRequest): Promise<FlyResult<SetSecretkeyResponse>> {
    const { app_name, secret_name, request } = payload
    return await this.client.restOrThrow(
      `apps/${app_name}/secretkeys/${secret_name}/generate`,
      'POST',
      request,
    )
  }

  async signSecretKey(payload: SecretKeySignRequest): Promise<FlyResult<SignSecretkeyResponse>> {
    const { app_name, secret_name, request, min_version } = payload
    const query = min_version ? `?min_version=${encodeURIComponent(min_version)}` : ''
    return await this.client.restOrThrow(`apps/${app_name}/secretkeys/${secret_name}/sign${query}`, 'POST', request)
  }

  async verifySecretKey(payload: SecretKeyVerifyRequest): Promise<FlyResult<void>> {
    const { app_name, secret_name, request, min_version } = payload
    const query = min_version ? `?min_version=${encodeURIComponent(min_version)}` : ''
    return await this.client.restOrThrow(`apps/${app_name}/secretkeys/${secret_name}/verify${query}`, 'POST', request)
  }

  async listSecrets(payload: ListSecretsRequest): Promise<FlyResult<AppSecrets>> {
    const { app_name, min_version, show_secrets } = payload
    const params = new URLSearchParams()
    if (min_version) {
      params.set('min_version', min_version)
    }
    if (show_secrets !== undefined) {
      params.set('show_secrets', String(show_secrets))
    }
    const query = params.toString()
    const path = `apps/${app_name}/secrets${query ? `?${query}` : ''}`
    return await this.client.restOrThrow(path)
  }

  async updateSecrets(payload: UpdateSecretsRequest): Promise<FlyResult<AppSecretsUpdateResp>> {
    const { app_name, request } = payload
    return await this.client.restOrThrow(`apps/${app_name}/secrets`, 'POST', request)
  }

  async getSecret(payload: SecretRequest): Promise<FlyResult<AppSecret>> {
    const { app_name, secret_name, min_version, show_secrets } = payload
    const params = new URLSearchParams()
    if (min_version) {
      params.set('min_version', min_version)
    }
    if (show_secrets !== undefined) {
      params.set('show_secrets', String(show_secrets))
    }
    const query = params.toString()
    const path = `apps/${app_name}/secrets/${secret_name}${query ? `?${query}` : ''}`
    return await this.client.restOrThrow(path)
  }

  async setSecret(payload: SetSecretRequest): Promise<FlyResult<SetAppSecretResponse>> {
    const { app_name, secret_name, request } = payload
    return await this.client.restOrThrow(`apps/${app_name}/secrets/${secret_name}`, 'POST', request)
  }

  async deleteSecret(payload: SecretRequest): Promise<FlyResult<DeleteAppSecretResponse>> {
    const { app_name, secret_name } = payload
    return await this.client.restOrThrow(`apps/${app_name}/secrets/${secret_name}`, 'DELETE')
  }
}
