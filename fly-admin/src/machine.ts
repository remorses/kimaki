// Machine management for Fly Machines REST API.
// Vendored from supabase/fly-admin with added exec, releaseLease, and metadata methods.

import { Client } from './client.ts'
import type { FlyResult } from './errors.ts'
import {
  ApiMachineConfig,
  ApiMachineInit,
  ApiMachineService,
  ApiMachineMount,
  ApiMachinePort,
  ApiMachineCheck,
  ApiMachineRestart,
  ApiMachineGuest,
  CheckStatus as ApiCheckStatus,
  CreateMachineRequest as ApiCreateMachineRequest,
  ImageRef as ApiImageRef,
  Machine as ApiMachine,
  MachineExecRequest as ApiMachineExecRequest,
  MachineExecResponse as ApiMachineExecResponse,
  StateEnum as ApiMachineState,
  SignalRequestSignalEnum as ApiMachineSignal,
  OrgMachine,
  OrgMachinesResponse as ApiOrgMachinesResponse,
  WaitMachineResponse as ApiWaitMachineResponse,
  MemoryResponse as ApiMemoryResponse,
  SetMemoryLimitRequest as ApiSetMemoryLimitRequest,
  ReclaimMemoryRequest as ApiReclaimMemoryRequest,
  ReclaimMemoryResponse as ApiReclaimMemoryResponse,
  Lease as ApiLease,
  ApiDuration,
  MetadataValueResponse,
  UpdateMetadataRequestBody,
  UpsertMetadataKeyRequest,
} from './types.ts'

export interface MachineConfig extends ApiMachineConfig {
  image: string
  schedule?: 'hourly' | 'daily' | 'weekly' | 'monthly'
}

export type ListMachineRequest =
  | string
  | {
      app_name: string
      include_deleted?: boolean
      region?: string
      state?: string
      summary?: boolean
    }

export interface CreateMachineRequest extends ApiCreateMachineRequest {
  app_name: string
  config: MachineConfig
}

interface BaseEvent {
  id: string
  type: string
  status: string
  source: 'flyd' | 'user'
  timestamp: number
}

interface StartEvent extends BaseEvent {
  type: 'start'
  status: 'started' | 'starting'
}

interface LaunchEvent extends BaseEvent {
  type: 'launch'
  status: 'created'
  source: 'user'
}

interface RestartEvent extends BaseEvent {
  type: 'restart'
  status: 'starting' | 'stopping'
  source: 'flyd' | 'user'
}

interface ExitEvent extends BaseEvent {
  type: 'exit'
  status: 'stopped'
  source: 'flyd'
  request: {
    exit_event: {
      requested_stop: boolean
      restarting: boolean
      guest_exit_code: number
      guest_signal: number
      guest_error: string
      exit_code: number
      signal: number
      error: string
      oom_killed: boolean
      exited_at: string
    }
    restart_count: number
  }
}

export type MachineEvent = LaunchEvent | StartEvent | RestartEvent | ExitEvent

export enum MachineState {
  Created = 'created',
  Starting = 'starting',
  Started = 'started',
  Stopping = 'stopping',
  Stopped = 'stopped',
  Suspended = 'suspended',
  Replacing = 'replacing',
  Destroying = 'destroying',
  Destroyed = 'destroyed',
  Failed = 'failed',
}

interface MachineMount extends ApiMachineMount {
  encrypted: boolean
  path: string
  size_gb: number
  volume: string
  name: string
}

export enum ConnectionHandler {
  TLS = 'tls',
  PG_TLS = 'pg_tls',
  HTTP = 'http',
  PROXY_PROTO = 'proxy_proto',
}

interface MachinePort extends ApiMachinePort {
  port: number
  handlers?: ConnectionHandler[]
}

interface MachineService extends ApiMachineService {
  protocol: 'tcp' | 'udp'
  internal_port: number
  ports: MachinePort[]
  concurrency?: {
    type: 'connections' | 'requests'
    soft_limit: number
    hard_limit: number
  }
}

interface MachineCheck extends ApiMachineCheck {
  type: 'tcp' | 'http'
  port: number
  interval: string
  timeout: string
}

interface MachineGuest extends ApiMachineGuest {
  cpu_kind: 'shared' | 'performance'
  cpus: number
  memory_mb: number
}

interface CheckStatus extends ApiCheckStatus {
  name: string
  status: 'passing' | 'warning' | 'critical'
  output: string
  updated_at: string
}

interface MachineImageRef extends Omit<ApiImageRef, 'labels'> {
  registry: string
  repository: string
  tag: string
  digest: string
  labels: Record<string, string> | null
}

export interface MachineResponse extends Omit<ApiMachine, 'image_ref'> {
  id: string
  name: string
  state: MachineState
  region: string
  instance_id: string
  private_ip: string
  host_status?: 'ok' | 'unknown' | 'unreachable'
  incomplete_config?: ApiMachineConfig
  nonce?: string
  config: {
    env: Record<string, string>
    init: ApiMachineInit
    mounts: MachineMount[]
    services: MachineService[]
    checks: Record<string, MachineCheck>
    restart: ApiMachineRestart
    guest: MachineGuest
    size: 'shared-cpu-1x' | 'shared-cpu-2x' | 'shared-cpu-4x'
  } & MachineConfig
  image_ref: MachineImageRef
  created_at: string
  updated_at: string
  events: MachineEvent[]
  checks: CheckStatus[]
}

export interface GetMachineRequest {
  app_name: string
  machine_id: string
}

interface OkResponse {
  ok: boolean
}

export interface DeleteMachineRequest extends GetMachineRequest {
  force?: boolean
}

export interface RestartMachineRequest extends GetMachineRequest {
  timeout?: string
  signal?: string
}

export interface SignalMachineRequest extends GetMachineRequest {
  signal: ApiMachineSignal
}

export interface StopMachineRequest extends GetMachineRequest {
  signal?: ApiMachineSignal
  timeout?: ApiDuration
}

export type StartMachineRequest = GetMachineRequest

export interface UpdateMachineRequest extends GetMachineRequest {
  config: MachineConfig
}

export type ListEventsRequest = GetMachineRequest
export type ListVersionsRequest = GetMachineRequest

export interface ListProcessesRequest extends GetMachineRequest {
  sort_by?: string
  order?: string
}

export interface ProcessResponse {
  command: string
  cpu: number
  directory: string
  listen_sockets: { address: string; proto: string }[]
  pid: number
  rss: number
  rtime: number
  stime: number
}

export interface WaitMachineRequest extends GetMachineRequest {
  instance_id?: string
  timeout?: number
  state?: ApiMachineState
  version?: string
  from_event_id?: string
}

export interface WaitMachineStopRequest extends WaitMachineRequest {
  instance_id: string
  state?: typeof ApiMachineState.Stopped | typeof ApiMachineState.Suspended
}

export interface MachineVersionResponse {
  user_config: MachineResponse
  version: string
}

export type GetLeaseRequest = GetMachineRequest

export interface LeaseResponse extends ApiLease {
  description: string
  expires_at: number
  nonce: string
  owner: string
  version?: string
}

export interface AcquireLeaseRequest extends GetLeaseRequest {
  description?: string
  ttl?: number
}

export interface ReleaseLeaseRequest extends GetLeaseRequest {
  nonce: string
}

export type CordonMachineRequest = GetMachineRequest
export type UncordonMachineRequest = GetMachineRequest

// --- Exec types ---

export interface ExecMachineRequest extends GetMachineRequest {
  command: string[]
  stdin?: string
  timeout?: number
  container?: string
}

export interface ExecMachineResponse {
  exit_code: number
  exit_signal: number
  stderr: string
  stdout: string
}

// --- Metadata types ---

export type GetMetadataRequest = GetMachineRequest

export interface UpdateMetadataRequest extends GetMachineRequest {
  request: UpdateMetadataRequestBody
}

export interface GetMetadataPropertyRequest extends GetMachineRequest {
  key: string
}

export interface SetMetadataPropertyRequest extends GetMachineRequest {
  key: string
  request: UpsertMetadataKeyRequest
}

export interface DeleteMetadataPropertyRequest extends GetMachineRequest {
  key: string
}

// --- Memory types ---

export interface MachineMemoryResponse extends ApiMemoryResponse {
  available_mb: number
  limit_mb: number
}

export interface UpdateMemoryRequest extends GetMachineRequest {
  limit_mb: number
}

export interface ReclaimMemoryMachineRequest extends GetMachineRequest {
  amount_mb?: number
}

export interface ReclaimMemoryResponse extends ApiReclaimMemoryResponse {
  actual_mb: number
}

// --- Org-level types ---

export interface ListOrgMachinesRequest {
  org_slug: string
  include_deleted?: boolean
  region?: string
  state?: string
  updated_after?: string
  cursor?: string
  limit?: number
}

export interface OrgMachinesResponse extends ApiOrgMachinesResponse {
  machines: OrgMachine[]
  last_machine_id?: string
  last_updated_at?: string
  next_cursor?: string
}

export interface ListEventsOptions extends GetMachineRequest {
  limit?: number
}

export class Machine {
  private client: Client

  constructor(client: Client) {
    this.client = client
  }

  // --- Core CRUD ---

  async listMachines(app_name: ListMachineRequest): Promise<FlyResult<MachineResponse[]>> {
    let path: string
    if (typeof app_name === 'string') {
      path = `apps/${app_name}/machines`
    } else {
      const { app_name: appId, ...params } = app_name
      path = `apps/${appId}/machines`
      const queryParams: Record<string, string> = {}
      if (params.include_deleted !== undefined) {
        queryParams.include_deleted = String(params.include_deleted)
      }
      if (params.region) {
        queryParams.region = params.region
      }
      if (params.state) {
        queryParams.state = params.state
      }
      if (params.summary !== undefined) {
        queryParams.summary = String(params.summary)
      }
      const query = new URLSearchParams(queryParams).toString()
      if (query) {
        path += `?${query}`
      }
    }
    return await this.client.restOrThrow(path)
  }

  async getMachine(payload: GetMachineRequest): Promise<FlyResult<MachineResponse>> {
    const { app_name, machine_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}`)
  }

  async createMachine(payload: CreateMachineRequest): Promise<FlyResult<MachineResponse>> {
    const { app_name, ...body } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines`, 'POST', body)
  }

  async updateMachine(payload: UpdateMachineRequest): Promise<FlyResult<MachineResponse>> {
    const { app_name, machine_id, ...body } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}`, 'POST', body)
  }

  async deleteMachine(payload: DeleteMachineRequest): Promise<FlyResult<OkResponse>> {
    const { app_name, machine_id, force } = payload
    const query = force ? '?force=true' : ''
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}${query}`, 'DELETE')
  }

  // --- Lifecycle control ---

  async startMachine(payload: StartMachineRequest): Promise<FlyResult<OkResponse>> {
    const { app_name, machine_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/start`, 'POST')
  }

  async stopMachine(payload: StopMachineRequest): Promise<FlyResult<OkResponse>> {
    const { app_name, machine_id, ...body } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/stop`, 'POST', {
      signal: ApiMachineSignal.SIGTERM,
      ...body,
    })
  }

  async restartMachine(payload: RestartMachineRequest): Promise<FlyResult<OkResponse>> {
    const { app_name, machine_id, ...params } = payload
    let path = `apps/${app_name}/machines/${machine_id}/restart`
    const queryParams: Record<string, string> = {}
    if (params.timeout) {
      queryParams.timeout = params.timeout
    }
    if (params.signal) {
      queryParams.signal = params.signal
    }
    const query = new URLSearchParams(queryParams).toString()
    if (query) {
      path += `?${query}`
    }
    return await this.client.restOrThrow(path, 'POST')
  }

  async signalMachine(payload: SignalMachineRequest): Promise<FlyResult<OkResponse>> {
    const { app_name, machine_id, ...body } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/signal`, 'POST', body)
  }

  async suspendMachine(payload: GetMachineRequest): Promise<FlyResult<OkResponse>> {
    const { app_name, machine_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/suspend`, 'POST')
  }

  // --- Memory ---

  async getMemory(payload: GetMachineRequest): Promise<FlyResult<MachineMemoryResponse>> {
    const { app_name, machine_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/memory`)
  }

  async setMemoryLimit(payload: UpdateMemoryRequest): Promise<FlyResult<MachineMemoryResponse>> {
    const { app_name, machine_id, ...body } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/memory`, 'PUT', body)
  }

  /** @deprecated use setMemoryLimit instead */
  async updateMemory(payload: UpdateMemoryRequest): Promise<FlyResult<MachineMemoryResponse>> {
    return this.setMemoryLimit(payload)
  }

  async reclaimMemory(payload: ReclaimMemoryMachineRequest): Promise<FlyResult<ReclaimMemoryResponse>> {
    const { app_name, machine_id, ...body } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/memory/reclaim`, 'POST', body)
  }

  // --- Monitoring ---

  async listEvents(payload: ListEventsOptions): Promise<FlyResult<MachineResponse['events']>> {
    const { app_name, machine_id, limit } = payload
    const query = limit !== undefined ? `?limit=${String(limit)}` : ''
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/events${query}`)
  }

  async listVersions(payload: ListVersionsRequest): Promise<FlyResult<MachineVersionResponse[]>> {
    const { app_name, machine_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/versions`)
  }

  async listProcesses(payload: ListProcessesRequest): Promise<FlyResult<ProcessResponse[]>> {
    const { app_name, machine_id, ...params } = payload
    let path = `apps/${app_name}/machines/${machine_id}/ps`
    const query = new URLSearchParams(params).toString()
    if (query) {
      path += `?${query}`
    }
    return await this.client.restOrThrow(path)
  }

  async waitMachine(payload: WaitMachineRequest): Promise<FlyResult<ApiWaitMachineResponse>> {
    const { app_name, machine_id, ...params } = payload
    let path = `apps/${app_name}/machines/${machine_id}/wait`
    const queryParams: Record<string, string> = {}
    if (params.instance_id) {
      queryParams.instance_id = params.instance_id
    }
    if (params.timeout !== undefined) {
      queryParams.timeout = String(params.timeout)
    }
    if (params.state) {
      queryParams.state = params.state
    }
    if (params.version) {
      queryParams.version = params.version
    }
    if (params.from_event_id) {
      queryParams.from_event_id = params.from_event_id
    }
    const query = new URLSearchParams(queryParams).toString()
    if (query) {
      path += `?${query}`
    }
    return await this.client.restOrThrow(path)
  }

  // --- Cordoning ---

  async cordonMachine(payload: CordonMachineRequest): Promise<FlyResult<OkResponse>> {
    const { app_name, machine_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/cordon`, 'POST')
  }

  async uncordonMachine(payload: UncordonMachineRequest): Promise<FlyResult<OkResponse>> {
    const { app_name, machine_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/uncordon`, 'POST')
  }

  // --- Leases ---

  async getLease(payload: GetLeaseRequest): Promise<FlyResult<LeaseResponse>> {
    const { app_name, machine_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/lease`)
  }

  async acquireLease(payload: AcquireLeaseRequest): Promise<FlyResult<LeaseResponse>> {
    const { app_name, machine_id, ...body } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/lease`, 'POST', body)
  }

  async releaseLease(payload: ReleaseLeaseRequest): Promise<FlyResult<void>> {
    const { app_name, machine_id, nonce } = payload
    return await this.client.restOrThrow(
      `apps/${app_name}/machines/${machine_id}/lease`,
      'DELETE',
      undefined,
      { 'fly-machine-lease-nonce': nonce },
    )
  }

  // --- Exec ---

  async execMachine(payload: ExecMachineRequest): Promise<FlyResult<ExecMachineResponse>> {
    const { app_name, machine_id, ...body } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/exec`, 'POST', body)
  }

  // --- Metadata ---

  async getMetadata(payload: GetMetadataRequest): Promise<FlyResult<Record<string, string>>> {
    const { app_name, machine_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/metadata`)
  }

  async updateMetadata(payload: UpdateMetadataRequest): Promise<FlyResult<void>> {
    const { app_name, machine_id, request } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/metadata`, 'PUT', request)
  }

  async getMetadataProperty(payload: GetMetadataPropertyRequest): Promise<FlyResult<MetadataValueResponse>> {
    const { app_name, machine_id, key } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/metadata/${key}`)
  }

  async setMetadataProperty(payload: SetMetadataPropertyRequest): Promise<FlyResult<void>> {
    const { app_name, machine_id, key, request } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/metadata/${key}`, 'POST', request)
  }

  async deleteMetadataProperty(payload: DeleteMetadataPropertyRequest): Promise<FlyResult<void>> {
    const { app_name, machine_id, key } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/metadata/${key}`, 'DELETE')
  }

  // --- Org-level ---

  async listOrgMachines(payload: ListOrgMachinesRequest): Promise<FlyResult<OrgMachinesResponse>> {
    const { org_slug, ...params } = payload
    let path = `orgs/${org_slug}/machines`
    const queryParams: Record<string, string> = {}
    if (params.include_deleted !== undefined) {
      queryParams.include_deleted = String(params.include_deleted)
    }
    if (params.region) {
      queryParams.region = params.region
    }
    if (params.state) {
      queryParams.state = params.state
    }
    if (params.updated_after) {
      queryParams.updated_after = params.updated_after
    }
    if (params.cursor) {
      queryParams.cursor = params.cursor
    }
    if (params.limit !== undefined) {
      queryParams.limit = String(params.limit)
    }
    const query = new URLSearchParams(queryParams).toString()
    if (query) {
      path += `?${query}`
    }
    return await this.client.restOrThrow(path)
  }
}
