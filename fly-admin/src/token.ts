// Token management for Fly Machines REST API.

import { Client } from './client.ts'
import type { CreateOIDCTokenRequest, CurrentTokenResponse } from './types.ts'

export interface RequestOIDCTokenRequest {
  request: CreateOIDCTokenRequest
}

export class Token {
  private client: Client

  constructor(client: Client) {
    this.client = client
  }

  async requestKmsToken(): Promise<string> {
    return await this.client.restOrThrow('tokens/kms', 'POST')
  }

  async requestOidcToken(payload: RequestOIDCTokenRequest): Promise<string> {
    return await this.client.restOrThrow('tokens/oidc', 'POST', payload.request)
  }

  async getCurrentToken(): Promise<CurrentTokenResponse> {
    return await this.client.restOrThrow('tokens/current')
  }
}
