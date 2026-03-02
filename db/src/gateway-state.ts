// Type-safe encode/decode for the OAuth state parameter passed between
// the CLI (discord/) and the website callback. If the shape changes,
// tsc will flag every call site in both packages.

export interface GatewayOAuthState {
  clientId: string
  clientSecret: string
}

export function encodeGatewayOAuthState(state: GatewayOAuthState): string {
  return JSON.stringify(state)
}

export function decodeGatewayOAuthState(raw: string): GatewayOAuthState | null {
  const parsed: unknown = JSON.parse(raw)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as GatewayOAuthState).clientId !== 'string' ||
    typeof (parsed as GatewayOAuthState).clientSecret !== 'string'
  ) {
    return null
  }
  return parsed as GatewayOAuthState
}
