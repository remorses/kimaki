// fly-admin — TypeScript client for Fly Machines REST and GraphQL APIs.
// Vendored fork of supabase/fly-admin. Uses native fetch, adds exec/releaseLease/metadata.

export { Client, FLY_API_GRAPHQL, FLY_API_HOSTNAME } from './client.ts'
export type { ClientConfig } from './client.ts'

export { App, AppStatus } from './app.ts'
export type {
  ListAppRequest,
  ListAppResponse,
  ListAppsParams,
  GetAppRequest,
  AppOrganizationInfo,
  AppInfo,
  AppResponse,
  IPAddress,
  CreateAppRequest,
  DeleteAppRequest,
  ListCertificatesRequest,
  RequestAcmeCertificateRequest,
  RequestCustomCertificateRequest,
  CertificateRequest,
  CreateDeployTokenRequest,
  ListSecretKeysRequest,
  SecretKeyRequest,
  SetSecretKeyRequest,
  SecretKeyDecryptRequest,
  SecretKeyEncryptRequest,
  SecretKeySignRequest,
  SecretKeyVerifyRequest,
  ListSecretsRequest,
  UpdateSecretsRequest,
  SecretRequest,
  SetSecretRequest,
  AssignIPAddressRequest,
  DeleteIPAddressRequest,
} from './app.ts'

export { Machine, MachineState, ConnectionHandler } from './machine.ts'
export type {
  MachineConfig,
  ListMachineRequest,
  CreateMachineRequest,
  MachineEvent,
  MachineResponse,
  GetMachineRequest,
  DeleteMachineRequest,
  RestartMachineRequest,
  SignalMachineRequest,
  StopMachineRequest,
  StartMachineRequest,
  UpdateMachineRequest,
  ListEventsRequest,
  ListVersionsRequest,
  ListProcessesRequest,
  ProcessResponse,
  WaitMachineRequest,
  WaitMachineStopRequest,
  MachineVersionResponse,
  GetLeaseRequest,
  LeaseResponse,
  AcquireLeaseRequest,
  ReleaseLeaseRequest,
  CordonMachineRequest,
  UncordonMachineRequest,
  ExecMachineRequest,
  ExecMachineResponse,
  GetMetadataRequest,
  UpdateMetadataRequest,
  GetMetadataPropertyRequest,
  SetMetadataPropertyRequest,
  DeleteMetadataPropertyRequest,
  MachineMemoryResponse,
  UpdateMemoryRequest,
  ReclaimMemoryMachineRequest,
  ReclaimMemoryResponse,
  ListOrgMachinesRequest,
  OrgMachinesResponse,
  ListEventsOptions,
} from './machine.ts'

export { Network, AddressType } from './network.ts'
export type {
  AllocateIPAddressInput,
  AllocateIPAddressOutput,
  ReleaseIPAddressInput,
  ReleaseIPAddressOutput,
} from './network.ts'

export { Organization } from './organization.ts'
export type { GetOrganizationInput, GetOrganizationOutput } from './organization.ts'

export { Regions } from './regions.ts'
export type { GetRegionsOutput, GetPlatformRegionsRequest } from './regions.ts'

export { Token } from './token.ts'
export type { RequestOIDCTokenRequest } from './token.ts'

export { Secret } from './secret.ts'
export type {
  SetSecretsInput,
  SetSecretsOutput,
  UnsetSecretsInput,
  UnsetSecretsOutput,
} from './secret.ts'

export { Volume } from './volume.ts'
export type {
  ListVolumesRequest,
  CreateVolumeRequest,
  VolumeResponse,
  GetVolumeRequest,
  UpdateVolumeRequest,
  DeleteVolumeRequest,
  ExtendVolumeRequest,
  ExtendVolumeResponse,
  ListSnapshotsRequest,
  SnapshotResponse,
} from './volume.ts'

export type * from './types.ts'

export function createClient(apiKey: string, config?: { graphqlUrl?: string; apiUrl?: string }) {
  return new Client(apiKey, config)
}

// Re-export Client as default for backwards compat with supabase/fly-admin
import { Client } from './client.ts'
export default Client
