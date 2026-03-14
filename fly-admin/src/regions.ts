// Region listing via Fly GraphQL API.

import { Client } from './client.ts'
import type {
  MainGetPlacementsRequest,
  MainGetPlacementsResponse,
  MainRegionResponse,
} from './types.ts'

interface RegionResponse {
  name: string
  code: string
  latitude: number
  longitude: number
  gatewayAvailable: boolean
  requiresPaidPlan: boolean
}

interface PlatformResponse {
  requestRegion: string
  regions: RegionResponse[]
}

export interface GetRegionsOutput {
  platform: PlatformResponse
}

export interface GetPlatformRegionsRequest {
  size?: string
  cpu_kind?: string
  memory_mb?: number
  cpus?: number
  gpus?: number
  gpu_kind?: string
}

const getRegionsQuery = `query {
  platform {
    requestRegion
    regions {
      name
      code
      latitude
      longitude
      gatewayAvailable
      requiresPaidPlan
    }
  }
}`

export class Regions {
  private client: Client

  constructor(client: Client) {
    this.client = client
  }

  async getRegions(): Promise<GetRegionsOutput> {
    return this.client.gqlPostOrThrow({
      query: getRegionsQuery,
      variables: {},
    })
  }

  async getPlatformRegions(payload: GetPlatformRegionsRequest = {}): Promise<MainRegionResponse> {
    const params = new URLSearchParams()
    if (payload.size) {
      params.set('size', payload.size)
    }
    if (payload.cpu_kind) {
      params.set('cpu_kind', payload.cpu_kind)
    }
    if (payload.memory_mb !== undefined) {
      params.set('memory_mb', String(payload.memory_mb))
    }
    if (payload.cpus !== undefined) {
      params.set('cpus', String(payload.cpus))
    }
    if (payload.gpus !== undefined) {
      params.set('gpus', String(payload.gpus))
    }
    if (payload.gpu_kind) {
      params.set('gpu_kind', payload.gpu_kind)
    }
    const query = params.toString()
    const path = `platform/regions${query ? `?${query}` : ''}`
    return await this.client.restOrThrow(path)
  }

  async getPlacements(request: MainGetPlacementsRequest): Promise<MainGetPlacementsResponse> {
    return await this.client.restOrThrow('platform/placements', 'POST', request)
  }
}
