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
  min_secrets_version?: number
  name?: string
  region?: string
  skip_launch?: boolean
  skip_secrets?: boolean
  skip_service_registration?: boolean
}

export interface CreateVolumeRequest {
  /** enable scheduled automatic snapshots. Defaults to `true` */
  auto_backup_enabled?: boolean
  compute?: ApiMachineGuest
  compute_image?: string
  encrypted?: boolean
  fstype?: string
  name?: string
  region?: string
  require_unique_zone?: boolean
  size_gb?: number
  /** restore from snapshot */
  snapshot_id?: string
  snapshot_retention?: number
  /** fork from remote volume */
  source_volume_id?: string
  unique_zone_app_wide?: boolean
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
  host_status?: 'ok' | 'unknown' | 'unreachable'
  id?: string
  image_ref?: ImageRef
  incomplete_config?: ApiMachineConfig
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
  timeout?: ApiDuration
}

export interface UpdateMachineRequest {
  config?: ApiMachineConfig
  current_version?: string
  lease_ttl?: number
  lsvd?: boolean
  min_secrets_version?: number
  name?: string
  region?: string
  skip_launch?: boolean
  skip_secrets?: boolean
  skip_service_registration?: boolean
}

export interface UpdateVolumeRequest {
  auto_backup_enabled?: boolean
  snapshot_retention?: number
}

export interface Volume {
  attached_alloc_id?: string
  attached_machine_id?: string
  auto_backup_enabled?: boolean
  block_size?: number
  blocks?: number
  blocks_avail?: number
  blocks_free?: number
  bytes_total?: number
  bytes_used?: number
  created_at?: string
  encrypted?: boolean
  fstype?: string
  host_status?: 'ok' | 'unknown' | 'unreachable'
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
  retention_days?: number
  size?: number
  status?: string
  volume_size?: number
}

export interface ApiDNSConfig {
  dns_forward_rules?: ApiDNSForwardRule[]
  hostname?: string
  hostname_fqdn?: string
  nameservers?: string[]
  options?: ApiDNSOption[]
  searches?: string[]
  skip_registration?: boolean
}

export interface ApiDNSForwardRule {
  addr?: string
  basename?: string
}

export interface ApiDNSOption {
  name?: string
  value?: string
}

export interface ApiFile {
  guest_path?: string
  image_config?: string
  mode?: number
  raw_value?: string
  secret_name?: string
}

export interface ApiHTTPOptions {
  compress?: boolean
  h2_backend?: boolean
  headers_read_timeout?: number
  idle_timeout?: number
  replay_cache?: ApiReplayCache[]
  response?: ApiHTTPResponseOptions
}

export interface ApiReplayCache {
  allow_bypass?: boolean
  /** Name of the cookie or header to key the cache on */
  name?: string
  path_prefix?: string
  ttl_seconds?: number
  type?: 'cookie' | 'header'
}

export interface ApiHTTPResponseOptions {
  headers?: Record<string, unknown>
  pristine?: boolean
}

export interface ApiMachineCheck {
  grace_period?: string
  headers?: ApiMachineHTTPHeader[]
  interval?: string
  kind?: 'informational' | 'readiness'
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
  containers?: ApiContainerConfig[]
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
  rootfs?: ApiMachineRootfs
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
  gpus?: number
  host_dedication_id?: string
  kernel_args?: string[]
  memory_mb?: number
  /** @deprecated use MachineConfig.Rootfs instead */
  persist_rootfs?: 'never' | 'always' | 'restart'
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
  https?: boolean
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
  env_from?: ApiEnvFrom[]
  exec?: string[]
  ignore_app_secrets?: boolean
  secrets?: ApiMachineSecret[]
  user?: string
}

export interface ApiMachineRestart {
  gpu_bid_price?: number
  max_retries?: number
  policy?: ApiMachineRestartPolicyEnum
}

export interface ApiMachineService {
  autostart?: boolean
  /** "off"|"stop"|"suspend" (string) or boolean for backward compat */
  autostop?: 'off' | 'stop' | 'suspend' | boolean
  checks?: ApiMachineServiceCheck[]
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
  index_document?: string
  tigris_bucket?: string
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

/** Go time.Duration represented as an integer (nanoseconds) */
export interface ApiDuration {
  'time.Duration'?: number
}

export interface ApiMachineRootfs {
  fs_size_gb?: number
  persist?: 'never' | 'always' | 'restart'
  size_gb?: number
}

export interface ApiMachineSecret {
  env_var?: string
  name?: string
}

export interface ApiEnvFrom {
  env_var?: string
  field_ref?: 'id' | 'version' | 'app_name' | 'private_ip' | 'region' | 'image'
}

export interface ApiContainerConfig {
  cmd?: string[]
  depends_on?: ApiContainerDependency[]
  entrypoint?: string[]
  env?: Record<string, string>
  env_from?: ApiEnvFrom[]
  exec?: string[]
  files?: ApiFile[]
  healthchecks?: ApiContainerHealthcheck[]
  image?: string
  name?: string
  restart?: ApiMachineRestart
  secrets?: ApiMachineSecret[]
  stop?: ApiStopConfig
  user?: string
}

export interface ApiContainerDependency {
  condition?: ApiContainerDependencyCondition
  name?: string
}

export type ApiContainerDependencyCondition = 'exited_successfully' | 'healthy' | 'started'

export interface ApiContainerHealthcheck {
  exec?: ApiExecHealthcheck
  failure_threshold?: number
  grace_period?: number
  http?: ApiHTTPHealthcheck
  interval?: number
  kind?: ApiContainerHealthcheckKind
  name?: string
  success_threshold?: number
  tcp?: ApiTCPHealthcheck
  timeout?: number
  unhealthy?: ApiUnhealthyPolicy
}

export type ApiContainerHealthcheckKind = 'readiness' | 'liveness'

export type ApiContainerHealthcheckScheme = 'http' | 'https'

export type ApiUnhealthyPolicy = 'stop'

export interface ApiExecHealthcheck {
  command?: string[]
}

export interface ApiHTTPHealthcheck {
  headers?: ApiMachineHTTPHeader[]
  method?: string
  path?: string
  port?: number
  scheme?: ApiContainerHealthcheckScheme
  tls_server_name?: string
  tls_skip_verify?: boolean
}

export interface ApiTCPHealthcheck {
  port?: number
}

export interface ApiMachineServiceCheck {
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

export interface WaitMachineResponse {
  event_id?: string
  ok?: boolean
  state?: string
  version?: string
}

export interface OrgMachine {
  app_id?: number
  app_name?: string
  created_at?: string
  id?: string
  instance_id?: string
  name?: string
  private_ip?: string
  region?: string
  state?: string
  updated_at?: string
}

export interface OrgMachinesResponse {
  last_machine_id?: string
  last_updated_at?: string
  machines?: OrgMachine[]
  next_cursor?: string
}

export interface AcmeChallenge {
  name?: string
  target?: string
}

export interface App {
  id?: string
  internal_numeric_id?: number
  machine_count?: number
  name?: string
  network?: string
  organization?: AppOrganizationInfo
  status?: string
  volume_count?: number
}

export interface AppOrganizationInfo {
  internal_numeric_id?: number
  name?: string
  slug?: string
}

export interface AppSecret {
  created_at?: string
  digest?: string
  name?: string
  updated_at?: string
  value?: string
}

export interface AppSecrets {
  secrets?: AppSecret[]
}

export interface AppSecretsUpdateRequest {
  values?: Record<string, string>
}

export interface AppSecretsUpdateResp {
  /** DEPRECATED */
  Version?: number
  secrets?: AppSecret[]
  version?: number
}

export interface CertificateCheckResponse {
  acme_requested?: boolean
  certificates?: CertificateEntry[]
  configured?: boolean
  dns_provider?: string
  dns_records?: DNSRecords
  dns_requirements?: DNSRequirements
  hostname?: string
  rate_limited_until?: string
  status?: string
  validation?: CertificateValidation
  validation_errors?: CertificateValidationError[]
}

export interface CertificateDetail {
  acme_requested?: boolean
  certificates?: CertificateEntry[]
  configured?: boolean
  dns_provider?: string
  dns_requirements?: DNSRequirements
  hostname?: string
  rate_limited_until?: string
  status?: string
  validation?: CertificateValidation
  validation_errors?: CertificateValidationError[]
}

export interface CertificateEntry {
  created_at?: string
  expires_at?: string
  issued?: IssuedCertificate[]
  issuer?: string
  source?: 'custom' | 'fly'
  status?: 'active' | 'pending_ownership' | 'pending_validation'
}

export interface CertificateSummary {
  acme_alpn_configured?: boolean
  acme_dns_configured?: boolean
  acme_http_configured?: boolean
  acme_requested?: boolean
  configured?: boolean
  created_at?: string
  dns_provider?: string
  has_custom_certificate?: boolean
  has_fly_certificate?: boolean
  hostname?: string
  ownership_txt_configured?: boolean
  status?: string
  updated_at?: string
}

export interface CertificateValidation {
  alpn_configured?: boolean
  dns_configured?: boolean
  http_configured?: boolean
  ownership_txt_configured?: boolean
}

export interface CertificateValidationError {
  code?: string
  message?: string
  remediation?: string
  timestamp?: string
}

export interface CreateAcmeCertificateRequest {
  hostname?: string
}

export interface CreateCustomCertificateRequest {
  cert?: string
  hostname?: string
  key?: string
}

export interface CreateAppDeployTokenRequest {
  expiry?: string
}

export interface CreateAppRequest {
  enable_subdomains?: boolean
  name?: string
  network?: string
  org_slug?: string
}

export interface CreateAppResponse {
  token?: string
}

export interface CreateLeaseRequest {
  description?: string
  /** seconds lease will be valid */
  ttl?: number
}

export interface CreateOIDCTokenRequest {
  aud?: string
  aws_principal_tags?: boolean
}

export interface CurrentTokenResponse {
  tokens?: MainTokenInfo[]
}

export interface DNSRecords {
  a?: string[]
  aaaa?: string[]
  acme_challenge_cname?: string
  cname?: string[]
  ownership_txt?: string
  resolved_addresses?: string[]
  soa?: string
}

export interface DNSRequirements {
  a?: string[]
  aaaa?: string[]
  acme_challenge?: AcmeChallenge
  cname?: string
  ownership?: OwnershipVerification
}

export interface DecryptSecretkeyRequest {
  associated_data?: number[]
  ciphertext?: number[]
}

export interface DecryptSecretkeyResponse {
  plaintext?: number[]
}

export interface DeleteAppSecretResponse {
  /** DEPRECATED */
  Version?: number
  version?: number
}

export interface DeleteSecretkeyResponse {
  /** DEPRECATED */
  Version?: number
  version?: number
}

export interface DestroyCustomCertificateResponse {
  acme_requested?: boolean
  certificates?: CertificateEntry[]
  configured?: boolean
  dns_provider?: string
  dns_requirements?: DNSRequirements
  hostname?: string
  rate_limited_until?: string
  status?: string
  validation?: CertificateValidation
  validation_errors?: CertificateValidationError[]
}

export interface EncryptSecretkeyRequest {
  associated_data?: number[]
  plaintext?: number[]
}

export interface EncryptSecretkeyResponse {
  ciphertext?: number[]
}

export interface IPAssignment {
  created_at?: string
  ip?: string
  region?: string
  service_name?: string
  shared?: boolean
}

export interface IssuedCertificate {
  certificate_authority?: string
  expires_at?: string
  type?: 'rsa' | 'ecdsa'
}

export interface ListAppsResponse {
  apps?: App[]
  total_apps?: number
}

export interface ListCertificatesResponse {
  certificates?: CertificateSummary[]
  next_cursor?: string
  total_count?: number
}

export interface ListIPAssignmentsResponse {
  ips?: IPAssignment[]
}

export interface MainGetPlacementsRequest {
  compute?: ApiMachineGuest
  count?: number
  org_slug: string
  region?: string
  volume_name?: string
  volume_size_bytes?: number
  weights?: PlacementWeights
}

export interface MainGetPlacementsResponse {
  regions?: PlacementRegionPlacement[]
}

export interface MainRegionResponse {
  nearest?: string
  regions?: ReadsGetCapacityPerRegionRow[]
}

export interface MainTokenInfo {
  apps?: string[]
  org_slug?: string
  organization?: string
  /** Machine the token is restricted to (FromMachine caveat) */
  restricted_to_machine?: string
  /** Machine making the request */
  source_machine_id?: string
  token_id?: string
  /** User identifier if token is for a user */
  user?: string
}

export interface MetadataValueResponse {
  value?: string
}

export interface OwnershipVerification {
  app_value?: string
  name?: string
  org_value?: string
}

export interface PlacementRegionPlacement {
  concurrency?: number
  count?: number
  region?: string
}

export type PlacementWeights = Record<string, number>

export interface ReadsGetCapacityPerRegionRow {
  capacity?: number
  code?: string
  deprecated?: boolean
  gateway_available?: boolean
  geo_region?: string
  latitude?: number
  longitude?: number
  name?: string
  requires_paid_plan?: boolean
}

export interface SecretKey {
  created_at?: string
  name?: string
  public_key?: number[]
  type?: string
  updated_at?: string
}

export interface SecretKeys {
  secret_keys?: SecretKey[]
}

export interface SetAppSecretRequest {
  value?: string
}

export interface SetAppSecretResponse {
  /** DEPRECATED */
  Version?: number
  created_at?: string
  digest?: string
  name?: string
  updated_at?: string
  value?: string
  version?: number
}

export interface SetSecretkeyRequest {
  type?: string
  value?: number[]
}

export interface SetSecretkeyResponse {
  /** DEPRECATED */
  Version?: number
  created_at?: string
  name?: string
  public_key?: number[]
  type?: string
  updated_at?: string
  version?: number
}

export interface SignSecretkeyRequest {
  plaintext?: number[]
}

export interface SignSecretkeyResponse {
  signature?: number[]
}

export interface UpdateMetadataRequestBody {
  machine_version?: string
  metadata?: Record<string, string>
  updated_at?: string
}

export interface UpsertMetadataKeyRequest {
  updated_at?: string
  value?: string
}

export interface VerifySecretkeyRequest {
  plaintext?: number[]
  signature?: number[]
}

// OpenAPI lowercase schema-name aliases.
export type createAcmeCertificateRequest = CreateAcmeCertificateRequest
export type createCustomCertificateRequest = CreateCustomCertificateRequest
export type destroyCustomCertificateResponse = DestroyCustomCertificateResponse
export type listCertificatesResponse = ListCertificatesResponse
export type listIPAssignmentsResponse = ListIPAssignmentsResponse
export type metadataValueResponse = MetadataValueResponse
export type updateMetadataRequest = UpdateMetadataRequestBody
export type upsertMetadataKeyRequest = UpsertMetadataKeyRequest
export interface assignIPRequest {
  region?: string
  service_name?: string
  type?: string
}

// OpenAPI schema aliases where schema names include dots.
export type FlyContainerConfig = ApiContainerConfig
export type FlyContainerDependency = ApiContainerDependency
export type FlyContainerDependencyCondition = ApiContainerDependencyCondition
export type FlyContainerHealthcheck = ApiContainerHealthcheck
export type FlyContainerHealthcheckKind = ApiContainerHealthcheckKind
export type FlyContainerHealthcheckScheme = ApiContainerHealthcheckScheme
export type FlyDNSConfig = ApiDNSConfig
export type FlyDuration = ApiDuration
export type FlyEnvFrom = ApiEnvFrom
export type FlyExecHealthcheck = ApiExecHealthcheck
export type FlyFile = ApiFile
export type FlyHTTPHealthcheck = ApiHTTPHealthcheck
export type FlyHTTPOptions = ApiHTTPOptions
export type FlyHTTPResponseOptions = ApiHTTPResponseOptions
export type FlyMachineCheck = ApiMachineCheck
export type FlyMachineConfig = ApiMachineConfig
export type FlyMachineGuest = ApiMachineGuest
export type FlyMachineHTTPHeader = ApiMachineHTTPHeader
export type FlyMachineInit = ApiMachineInit
export type FlyMachineMetrics = ApiMachineMetrics
export type FlyMachineMount = ApiMachineMount
export type FlyMachinePort = ApiMachinePort
export type FlyMachineProcess = ApiMachineProcess
export type FlyMachineRestart = ApiMachineRestart
export type FlyMachineRootfs = ApiMachineRootfs
export type FlyMachineSecret = ApiMachineSecret
export type FlyMachineService = ApiMachineService
export type FlyMachineServiceCheck = ApiMachineServiceCheck
export type FlyMachineServiceConcurrency = ApiMachineServiceConcurrency
export type FlyProxyProtoOptions = ApiProxyProtoOptions
export type FlyReplayCache = ApiReplayCache
export type FlyStatic = ApiStatic
export type FlyStopConfig = ApiStopConfig
export type FlyTCPHealthcheck = ApiTCPHealthcheck
export type FlyTLSOptions = ApiTLSOptions
export type FlyUnhealthyPolicy = ApiUnhealthyPolicy
export type FlyDNSForwardRule = ApiDNSForwardRule
export type FlyDNSOption = ApiDNSOption
export type Flydv1ExecResponse = MachineExecResponse
export type MainMemoryResponse = MemoryResponse
export type MainReclaimMemoryRequest = ReclaimMemoryRequest
export type MainReclaimMemoryResponse = ReclaimMemoryResponse
export type MainSetMemoryLimitRequest = SetMemoryLimitRequest

// OpenAPI component schema name map for schemas with non-identifier names.
export interface OpenApiComponentSchemaMap {
  'fly.ContainerConfig': FlyContainerConfig
  'fly.ContainerDependency': FlyContainerDependency
  'fly.ContainerDependencyCondition': FlyContainerDependencyCondition
  'fly.ContainerHealthcheck': FlyContainerHealthcheck
  'fly.ContainerHealthcheckKind': FlyContainerHealthcheckKind
  'fly.ContainerHealthcheckScheme': FlyContainerHealthcheckScheme
  'fly.DNSConfig': FlyDNSConfig
  'fly.Duration': FlyDuration
  'fly.EnvFrom': FlyEnvFrom
  'fly.ExecHealthcheck': FlyExecHealthcheck
  'fly.File': FlyFile
  'fly.HTTPHealthcheck': FlyHTTPHealthcheck
  'fly.HTTPOptions': FlyHTTPOptions
  'fly.HTTPResponseOptions': FlyHTTPResponseOptions
  'fly.MachineCheck': FlyMachineCheck
  'fly.MachineConfig': FlyMachineConfig
  'fly.MachineGuest': FlyMachineGuest
  'fly.MachineHTTPHeader': FlyMachineHTTPHeader
  'fly.MachineInit': FlyMachineInit
  'fly.MachineMetrics': FlyMachineMetrics
  'fly.MachineMount': FlyMachineMount
  'fly.MachinePort': FlyMachinePort
  'fly.MachineProcess': FlyMachineProcess
  'fly.MachineRestart': FlyMachineRestart
  'fly.MachineRootfs': FlyMachineRootfs
  'fly.MachineSecret': FlyMachineSecret
  'fly.MachineService': FlyMachineService
  'fly.MachineServiceCheck': FlyMachineServiceCheck
  'fly.MachineServiceConcurrency': FlyMachineServiceConcurrency
  'fly.ProxyProtoOptions': FlyProxyProtoOptions
  'fly.ReplayCache': FlyReplayCache
  'fly.Static': FlyStatic
  'fly.StopConfig': FlyStopConfig
  'fly.TCPHealthcheck': FlyTCPHealthcheck
  'fly.TLSOptions': FlyTLSOptions
  'fly.UnhealthyPolicy': FlyUnhealthyPolicy
  'fly.dnsForwardRule': FlyDNSForwardRule
  'fly.dnsOption': FlyDNSOption
  'flydv1.ExecResponse': Flydv1ExecResponse
  'main.getPlacementsRequest': MainGetPlacementsRequest
  'main.getPlacementsResponse': MainGetPlacementsResponse
  'main.memoryResponse': MainMemoryResponse
  'main.reclaimMemoryRequest': MainReclaimMemoryRequest
  'main.reclaimMemoryResponse': MainReclaimMemoryResponse
  'main.regionResponse': MainRegionResponse
  'main.setMemoryLimitRequest': MainSetMemoryLimitRequest
  'main.statusCode': MainStatusCode
  'main.tokenInfo': MainTokenInfo
  'placement.RegionPlacement': PlacementRegionPlacement
  'placement.Weights': PlacementWeights
  'reads.GetCapacityPerRegionRow': ReadsGetCapacityPerRegionRow
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
  SpotPrice = 'spot-price',
}

export enum StateEnum {
  Created = 'created',
  Started = 'started',
  Stopped = 'stopped',
  Suspended = 'suspended',
  Destroyed = 'destroyed',
  Failed = 'failed',
  Settled = 'settled',
}

// --- Memory types (from main.* schemas) ---

export interface MemoryResponse {
  available_mb?: number
  limit_mb?: number
}

export interface SetMemoryLimitRequest {
  limit_mb?: number
}

export interface ReclaimMemoryRequest {
  amount_mb?: number
}

export interface ReclaimMemoryResponse {
  actual_mb?: number
}
