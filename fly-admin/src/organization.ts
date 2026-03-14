// Organization queries via Fly GraphQL API.

import { Client } from './client.ts'

export type GetOrganizationInput = string

interface OrganizationResponse {
  id: string
  slug: string
  name: string
  type: 'PERSONAL' | 'SHARED'
  viewerRole: 'admin' | 'member'
}

export interface GetOrganizationOutput {
  organization: OrganizationResponse
}

const getOrganizationQuery = `query($slug: String!) {
  organization(slug: $slug) {
    id
    slug
    name
    type
    viewerRole
  }
}`

export class Organization {
  private client: Client

  constructor(client: Client) {
    this.client = client
  }

  async getOrganization(slug: GetOrganizationInput): Promise<GetOrganizationOutput> {
    return this.client.gqlPostOrThrow({
      query: getOrganizationQuery,
      variables: { slug },
    })
  }
}
