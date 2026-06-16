// Token management for Fly Machines REST API.

import { Client } from './client.ts'
import type { CreateOIDCTokenRequest, CurrentTokenResponse } from './types.ts'
import type { FlyResult } from './errors.ts'

export interface RequestOIDCTokenRequest {
  request: CreateOIDCTokenRequest
}

export class Token {
  private client: Client

  constructor(client: Client) {
    this.client = client
  }

  async requestKmsToken(): Promise<FlyResult<string>> {
    return await this.client.restOrThrow('tokens/kms', 'POST')
  }

  async requestOidcToken(payload: RequestOIDCTokenRequest): Promise<FlyResult<string>> {
    return await this.client.restOrThrow('tokens/oidc', 'POST', payload.request)
  }

  async getCurrentToken(): Promise<FlyResult<CurrentTokenResponse>> {
    return await this.client.restOrThrow('tokens/current')
  }
}
