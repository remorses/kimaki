// Volume management for Fly Machines REST API.

import { Client } from './client.ts'
import { CreateVolumeRequest as ApiCreateVolumeRequest, UpdateVolumeRequest as ApiUpdateVolumeRequest } from './types.ts'

export interface ListVolumesRequest {
  app_name: string
  /** Only return summary info about volumes (omit blocks, block size, etc) */
  summary?: boolean
}

export interface CreateVolumeRequest extends ApiCreateVolumeRequest {
  app_name: string
  name: string
  region: string
}

export interface VolumeResponse {
  id: string
  name: string
  state: string
  size_gb: number
  region: string
  zone: string
  encrypted: boolean
  attached_machine_id: string | null
  attached_alloc_id: string | null
  auto_backup_enabled: boolean
  created_at: string
  blocks: number
  block_size: number
  blocks_free: number
  blocks_avail: number
  bytes_total: number
  bytes_used: number
  fstype: string
  host_status: 'ok' | 'unknown' | 'unreachable'
  snapshot_retention: number
}

export interface GetVolumeRequest {
  app_name: string
  volume_id: string
}

export type DeleteVolumeRequest = GetVolumeRequest

export interface UpdateVolumeRequest extends GetVolumeRequest, ApiUpdateVolumeRequest {}

export interface ExtendVolumeRequest extends GetVolumeRequest {
  size_gb: number
}

export interface ExtendVolumeResponse {
  needs_restart: boolean
  volume: VolumeResponse
}

export type ListSnapshotsRequest = GetVolumeRequest

export interface SnapshotResponse {
  id: string
  created_at: string
  digest: string
  retention_days: number
  size: number
  status: string
  volume_size: number
}

export class Volume {
  private client: Client

  constructor(client: Client) {
    this.client = client
  }

  async listVolumes(payload: ListVolumesRequest): Promise<VolumeResponse[]> {
    const { app_name, summary } = payload
    const params = new URLSearchParams()
    if (summary !== undefined) {
      params.set('summary', String(summary))
    }
    const query = params.toString()
    const path = `apps/${app_name}/volumes${query ? `?${query}` : ''}`
    return await this.client.restOrThrow(path)
  }

  async getVolume(payload: GetVolumeRequest): Promise<VolumeResponse> {
    const { app_name, volume_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/volumes/${volume_id}`)
  }

  async createVolume(payload: CreateVolumeRequest): Promise<VolumeResponse> {
    const { app_name, ...body } = payload
    return await this.client.restOrThrow(`apps/${app_name}/volumes`, 'POST', body)
  }

  async updateVolume(payload: UpdateVolumeRequest): Promise<VolumeResponse> {
    const { app_name, volume_id, ...body } = payload
    return await this.client.restOrThrow(`apps/${app_name}/volumes/${volume_id}`, 'PUT', body)
  }

  async deleteVolume(payload: DeleteVolumeRequest): Promise<VolumeResponse> {
    const { app_name, volume_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/volumes/${volume_id}`, 'DELETE')
  }

  async extendVolume(payload: ExtendVolumeRequest): Promise<ExtendVolumeResponse> {
    const { app_name, volume_id, ...body } = payload
    return await this.client.restOrThrow(`apps/${app_name}/volumes/${volume_id}/extend`, 'PUT', body)
  }

  async listSnapshots(payload: ListSnapshotsRequest): Promise<SnapshotResponse[]> {
    const { app_name, volume_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/volumes/${volume_id}/snapshots`)
  }

  async createSnapshot(payload: GetVolumeRequest): Promise<SnapshotResponse> {
    const { app_name, volume_id } = payload
    return await this.client.restOrThrow(`apps/${app_name}/volumes/${volume_id}/snapshots`, 'POST')
  }
}
