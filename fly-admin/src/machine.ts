// Machine management for Fly Machines REST API.
// Vendored from supabase/fly-admin with added exec, releaseLease, and metadata methods.

import { Client } from './client.ts'
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
} from './types.ts'

export interface MachineConfig extends ApiMachineConfig {
  image: string
  schedule?: 'hourly' | 'daily' | 'weekly' | 'monthly'
}

export type ListMachineRequest =
  | string
  | {
      app_name: string
      include_deleted?: ''
      region?: string
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
  Replacing = 'replacing',
  Destroying = 'destroying',
  Destroyed = 'destroyed',
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
}

export interface SignalMachineRequest extends GetMachineRequest {
  signal: ApiMachineSignal
}

export interface StopMachineRequest extends RestartMachineRequest {
  signal?: ApiMachineSignal
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
  timeout?: string
  state?: ApiMachineState
}

export interface WaitMachineStopRequest extends WaitMachineRequest {
  instance_id: string
  state?: typeof ApiMachineState.Stopped
}

export interface MachineVersionResponse {
  user_config: MachineResponse
  version: string
}

export type GetLeaseRequest = GetMachineRequest

export interface LeaseResponse {
  status: 'success'
  data: {
    description: string
    expires_at: number
    nonce: string
    owner: string
  }
}

export interface AcquireLeaseRequest extends GetLeaseRequest {
  description?: string
  ttl: number
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
  metadata: Record<string, string>
}

export interface GetMetadataPropertyRequest extends GetMachineRequest {
  key: string
}

export interface SetMetadataPropertyRequest extends GetMachineRequest {
  key: string
  value: string
}

export interface DeleteMetadataPropertyRequest extends GetMachineRequest {
  key: string
}

export class Machine {
  private client: Client

  constructor(client: Client) {
    this.client = client
  }

  // --- Core CRUD ---

  async listMachines(app_name: ListMachineRequest): Promise<MachineResponse[]> {
    let path: string
    if (typeof app_name === 'string') {
      path = `apps/${app_name}/machines`
    } else {
      const { app_name: appId, ...params } = app_name
      path = `apps/${appId}/machines`
      const query = new URLSearchParams(params).toString()
      if (query) {
        path += `?${query}`
      }
    }
    return await this.client.restOrThrow(path)
  }

  async getMachine(payload: GetMachineRequest): Promise<MachineResponse> {
    const { app_name, machine_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}`)
  }

  async createMachine(payload: CreateMachineRequest): Promise<MachineResponse> {
    const { app_name, ...body } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines`, 'POST', body)
  }

  async updateMachine(payload: UpdateMachineRequest): Promise<MachineResponse> {
    const { app_name, machine_id, ...body } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}`, 'POST', body)
  }

  async deleteMachine(payload: DeleteMachineRequest): Promise<OkResponse> {
    const { app_name, machine_id, force } = payload
    const query = force ? '?kill=true' : ''
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}${query}`, 'DELETE')
  }

  // --- Lifecycle control ---

  async startMachine(payload: StartMachineRequest): Promise<OkResponse> {
    const { app_name, machine_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/start`, 'POST')
  }

  async stopMachine(payload: StopMachineRequest): Promise<OkResponse> {
    const { app_name, machine_id, ...body } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/stop`, 'POST', {
      signal: ApiMachineSignal.SIGTERM,
      ...body,
    })
  }

  async restartMachine(payload: RestartMachineRequest): Promise<OkResponse> {
    const { app_name, machine_id, ...body } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/restart`, 'POST', body)
  }

  async signalMachine(payload: SignalMachineRequest): Promise<OkResponse> {
    const { app_name, machine_id, ...body } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/signal`, 'POST', body)
  }

  // --- Monitoring ---

  async listEvents(payload: ListEventsRequest): Promise<MachineResponse['events']> {
    const { app_name, machine_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/events`)
  }

  async listVersions(payload: ListVersionsRequest): Promise<MachineVersionResponse[]> {
    const { app_name, machine_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/versions`)
  }

  async listProcesses(payload: ListProcessesRequest): Promise<ProcessResponse> {
    const { app_name, machine_id, ...params } = payload
    let path = `apps/${app_name}/machines/${machine_id}/ps`
    const query = new URLSearchParams(params).toString()
    if (query) {
      path += `?${query}`
    }
    return await this.client.restOrThrow(path)
  }

  async waitMachine(payload: WaitMachineRequest): Promise<OkResponse> {
    const { app_name, machine_id, ...params } = payload
    let path = `apps/${app_name}/machines/${machine_id}/wait`
    const resolvedParams = { ...params } as Record<string, string>
    if (resolvedParams.timeout?.endsWith('s')) {
      resolvedParams.timeout = resolvedParams.timeout.slice(0, -1)
    }
    const query = new URLSearchParams(resolvedParams).toString()
    if (query) {
      path += `?${query}`
    }
    return await this.client.restOrThrow(path)
  }

  // --- Cordoning ---

  async cordonMachine(payload: CordonMachineRequest): Promise<OkResponse> {
    const { app_name, machine_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/cordon`, 'POST')
  }

  async uncordonMachine(payload: UncordonMachineRequest): Promise<OkResponse> {
    const { app_name, machine_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/uncordon`, 'POST')
  }

  // --- Leases ---

  async getLease(payload: GetLeaseRequest): Promise<LeaseResponse> {
    const { app_name, machine_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/lease`)
  }

  async acquireLease(payload: AcquireLeaseRequest): Promise<LeaseResponse> {
    const { app_name, machine_id, ...body } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/lease`, 'POST', body)
  }

  async releaseLease(payload: ReleaseLeaseRequest): Promise<void> {
    const { app_name, machine_id, nonce } = payload
    await this.client.restOrThrow(
      `apps/${app_name}/machines/${machine_id}/lease`,
      'DELETE',
      undefined,
      { 'fly-machine-lease-nonce': nonce },
    )
  }

  // --- Exec ---

  async execMachine(payload: ExecMachineRequest): Promise<ExecMachineResponse> {
    const { app_name, machine_id, ...body } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/exec`, 'POST', body)
  }

  // --- Metadata ---

  async getMetadata(payload: GetMetadataRequest): Promise<Record<string, string>> {
    const { app_name, machine_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/metadata`)
  }

  async updateMetadata(payload: UpdateMetadataRequest): Promise<Record<string, string>> {
    const { app_name, machine_id, metadata } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/metadata`, 'PUT', metadata)
  }

  async getMetadataProperty(payload: GetMetadataPropertyRequest): Promise<string> {
    const { app_name, machine_id, key } = payload
    return await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/metadata/${key}`)
  }

  async setMetadataProperty(payload: SetMetadataPropertyRequest): Promise<void> {
    const { app_name, machine_id, key, value } = payload
    await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/metadata/${key}`, 'POST', value)
  }

  async deleteMetadataProperty(payload: DeleteMetadataPropertyRequest): Promise<void> {
    const { app_name, machine_id, key } = payload
    await this.client.restOrThrow(`apps/${app_name}/machines/${machine_id}/metadata/${key}`, 'DELETE')
  }
}
