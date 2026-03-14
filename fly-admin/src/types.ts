// Generated types from Fly Machines OpenAPI spec.
// Originally produced by swagger-typescript-api from supabase/fly-admin.

export interface CheckStatus {
  name?: string
  output?: string
  status?: string
  updated_at?: string
}

export interface CreateMachineRequest {
  config?: ApiMachineConfig
  lease_ttl?: number
  lsvd?: boolean
  name?: string
  region?: string
  skip_launch?: boolean
  skip_service_registration?: boolean
}

export interface CreateVolumeRequest {
  compute?: ApiMachineGuest
  encrypted?: boolean
  fstype?: string
  machines_only?: boolean
  name?: string
  region?: string
  require_unique_zone?: boolean
  size_gb?: number
  snapshot_id?: string
  snapshot_retention?: number
  source_volume_id?: string
}

export interface ErrorResponse {
  details?: unknown
  error?: string
  status?: MainStatusCode
}

export interface ExtendVolumeRequest {
  size_gb?: number
}

export interface ExtendVolumeResponse {
  needs_restart?: boolean
  volume?: Volume
}

export interface ImageRef {
  digest?: string
  labels?: Record<string, string>
  registry?: string
  repository?: string
  tag?: string
}

export interface Lease {
  description?: string
  expires_at?: number
  nonce?: string
  owner?: string
  version?: string
}

export interface Machine {
  checks?: CheckStatus[]
  config?: ApiMachineConfig
  created_at?: string
  events?: MachineEvent[]
  id?: string
  image_ref?: ImageRef
  instance_id?: string
  name?: string
  nonce?: string
  private_ip?: string
  region?: string
  state?: string
  updated_at?: string
}

export interface MachineEvent {
  id?: string
  request?: unknown
  source?: string
  status?: string
  timestamp?: number
  type?: string
}

export interface MachineExecRequest {
  /** @deprecated use command instead */
  cmd?: string
  command?: string[]
  timeout?: number
  container?: string
  stdin?: string
}

export interface MachineExecResponse {
  exit_code?: number
  exit_signal?: number
  stderr?: string
  stdout?: string
}

export interface MachineVersion {
  user_config?: ApiMachineConfig
  version?: string
}

export interface Organization {
  name?: string
  slug?: string
}

export interface ProcessStat {
  command?: string
  cpu?: number
  directory?: string
  listen_sockets?: ListenSocket[]
  pid?: number
  rss?: number
  rtime?: number
  stime?: number
}

export interface ListenSocket {
  address?: string
  proto?: string
}

export interface SignalRequest {
  signal?: SignalRequestSignalEnum
}

export interface StopRequest {
  signal?: string
  timeout?: string
}

export interface UpdateMachineRequest {
  config?: ApiMachineConfig
  current_version?: string
  lease_ttl?: number
  lsvd?: boolean
  name?: string
  region?: string
  skip_launch?: boolean
  skip_service_registration?: boolean
}

export interface UpdateVolumeRequest {
  snapshot_retention?: number
}

export interface Volume {
  attached_alloc_id?: string
  attached_machine_id?: string
  block_size?: number
  blocks?: number
  blocks_avail?: number
  blocks_free?: number
  created_at?: string
  encrypted?: boolean
  fstype?: string
  id?: string
  name?: string
  region?: string
  size_gb?: number
  snapshot_retention?: number
  state?: string
  zone?: string
}

export interface VolumeSnapshot {
  created_at?: string
  digest?: string
  id?: string
  size?: number
  status?: string
}

export interface ApiDNSConfig {
  skip_registration?: boolean
}

export interface ApiFile {
  guest_path?: string
  raw_value?: string
  secret_name?: string
}

export interface ApiHTTPOptions {
  compress?: boolean
  h2_backend?: boolean
  response?: ApiHTTPResponseOptions
}

export interface ApiHTTPResponseOptions {
  headers?: Record<string, unknown>
}

export interface ApiMachineCheck {
  grace_period?: string
  headers?: ApiMachineHTTPHeader[]
  interval?: string
  method?: string
  path?: string
  port?: number
  protocol?: string
  timeout?: string
  tls_server_name?: string
  tls_skip_verify?: boolean
  type?: string
}

export interface ApiMachineConfig {
  auto_destroy?: boolean
  checks?: Record<string, ApiMachineCheck>
  /** @deprecated use Service.Autostart instead */
  disable_machine_autostart?: boolean
  dns?: ApiDNSConfig
  env?: Record<string, string>
  files?: ApiFile[]
  guest?: ApiMachineGuest
  image?: string
  init?: ApiMachineInit
  metadata?: Record<string, string>
  metrics?: ApiMachineMetrics
  mounts?: ApiMachineMount[]
  processes?: ApiMachineProcess[]
  restart?: ApiMachineRestart
  schedule?: string
  services?: ApiMachineService[]
  /** @deprecated use Guest instead */
  size?: string
  standbys?: string[]
  statics?: ApiStatic[]
  stop_config?: ApiStopConfig
}

export interface ApiMachineGuest {
  cpu_kind?: string
  cpus?: number
  gpu_kind?: string
  host_dedication_id?: string
  kernel_args?: string[]
  memory_mb?: number
}

export interface ApiMachineHTTPHeader {
  name?: string
  values?: string[]
}

export interface ApiMachineInit {
  cmd?: string[]
  entrypoint?: string[]
  exec?: string[]
  kernel_args?: string[]
  swap_size_mb?: number
  tty?: boolean
}

export interface ApiMachineMetrics {
  path?: string
  port?: number
}

export interface ApiMachineMount {
  add_size_gb?: number
  encrypted?: boolean
  extend_threshold_percent?: number
  name?: string
  path?: string
  size_gb?: number
  size_gb_limit?: number
  volume?: string
}

export interface ApiMachinePort {
  end_port?: number
  force_https?: boolean
  handlers?: string[]
  http_options?: ApiHTTPOptions
  port?: number
  proxy_proto_options?: ApiProxyProtoOptions
  start_port?: number
  tls_options?: ApiTLSOptions
}

export interface ApiMachineProcess {
  cmd?: string[]
  entrypoint?: string[]
  env?: Record<string, string>
  exec?: string[]
  user?: string
}

export interface ApiMachineRestart {
  max_retries?: number
  policy?: ApiMachineRestartPolicyEnum
}

export interface ApiMachineService {
  autostart?: boolean
  autostop?: boolean
  checks?: ApiMachineCheck[]
  concurrency?: ApiMachineServiceConcurrency
  force_instance_description?: string
  force_instance_key?: string
  internal_port?: number
  min_machines_running?: number
  ports?: ApiMachinePort[]
  protocol?: string
}

export interface ApiMachineServiceConcurrency {
  hard_limit?: number
  soft_limit?: number
  type?: string
}

export interface ApiProxyProtoOptions {
  version?: string
}

export interface ApiStatic {
  guest_path: string
  url_prefix: string
}

export interface ApiStopConfig {
  signal?: string
  timeout?: string
}

export interface ApiTLSOptions {
  alpn?: string[]
  default_self_signed?: boolean
  versions?: string[]
}

export enum MainStatusCode {
  Unknown = 'unknown',
  CapacityErr = 'insufficient_capacity',
}

export enum SignalRequestSignalEnum {
  SIGABRT = 'SIGABRT',
  SIGALRM = 'SIGALRM',
  SIGFPE = 'SIGFPE',
  SIGHUP = 'SIGHUP',
  SIGILL = 'SIGILL',
  SIGINT = 'SIGINT',
  SIGKILL = 'SIGKILL',
  SIGPIPE = 'SIGPIPE',
  SIGQUIT = 'SIGQUIT',
  SIGSEGV = 'SIGSEGV',
  SIGTERM = 'SIGTERM',
  SIGTRAP = 'SIGTRAP',
  SIGUSR1 = 'SIGUSR1',
}

export enum ApiMachineRestartPolicyEnum {
  No = 'no',
  Always = 'always',
  OnFailure = 'on-failure',
}

export enum StateEnum {
  Started = 'started',
  Stopped = 'stopped',
  Destroyed = 'destroyed',
}
