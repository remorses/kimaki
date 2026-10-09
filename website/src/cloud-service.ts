// Kimaki Cloud service layer.
// Wraps @fly.io/sdk for machine lifecycle and provides pricing/region constants.
// Also constructs the Discord install URL for gateway onboarding (same formula
// as gatewayInstallUrl in kimaki/src/credentials.ts, duplicated here to avoid
// importing the kimaki package which would bloat the CF Worker bundle).

import { createClient, FlyNotFoundError, type FlyResult } from '@fly.io/sdk'

export const CLOUD_REGIONS = [
  { code: 'iad', label: 'US East (Virginia)' },
  { code: 'sjc', label: 'US West (San Jose)' },
  { code: 'ams', label: 'Europe (Amsterdam)' },
  { code: 'nrt', label: 'Asia (Tokyo)' },
  { code: 'syd', label: 'Oceania (Sydney)' },
  { code: 'gru', label: 'South America (São Paulo)' },
] as const

export type CloudRegionCode = (typeof CLOUD_REGIONS)[number]['code']

// Fly pricing per hour (USD), used for 2x markup display
// Source: https://fly.io/pricing/ (shared-cpu)
const FLY_SHARED_CPU_PER_HOUR = 0.0027 // per shared vCPU
const FLY_MEMORY_PER_GB_PER_HOUR = 0.006 // per GB RAM
const FLY_VOLUME_PER_GB_PER_MONTH = 0.15
const MARKUP = 2

export function estimateMonthlyCost({
  cpus,
  memoryMb,
  diskSizeGb,
}: {
  cpus: number
  memoryMb: number
  diskSizeGb: number
}) {
  const hoursPerMonth = 730
  const computePerHour = cpus * FLY_SHARED_CPU_PER_HOUR + (memoryMb / 1024) * FLY_MEMORY_PER_GB_PER_HOUR
  const computeMonthly = computePerHour * hoursPerMonth * MARKUP
  const storageMonthly = diskSizeGb * FLY_VOLUME_PER_GB_PER_MONTH * MARKUP
  return {
    compute: Math.round(computeMonthly * 100) / 100,
    storage: Math.round(storageMonthly * 100) / 100,
    total: Math.round((computeMonthly + storageMonthly) * 100) / 100,
  }
}

// Constructs the Discord install URL for a cloud machine.
// Same formula as gatewayInstallUrl in kimaki/src/credentials.ts, plus the reachable URL.
export function constructInstallUrl({
  clientId,
  clientSecret,
  callbackUrl,
  reachableUrl,
  websiteOrigin,
}: {
  clientId: string
  clientSecret: string
  callbackUrl?: string
  reachableUrl?: string
  websiteOrigin: string
}) {
  const url = new URL('/discord-install', websiteOrigin)
  url.searchParams.set('clientId', clientId)
  url.searchParams.set('clientSecret', clientSecret)
  if (callbackUrl) {
    url.searchParams.set('kimakiCallbackUrl', callbackUrl)
  }
  if (reachableUrl) {
    url.searchParams.set('reachableUrl', reachableUrl)
  }
  return url.toString()
}

export function createFlyClient(apiToken: string) {
  return createClient({ apiKey: apiToken })
}

// TODO: remove when billing exists. Temporary unpaid-provisioning gate.
export function parseCloudProvisionAllowlist(raw: string | undefined) {
  if (!raw) return new Set<string>()
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  )
}

export function isCloudProvisionAllowed({
  allowlist,
  email,
  discordAccountId,
}: {
  allowlist: Set<string>
  email?: string | null
  discordAccountId?: string | null
}) {
  if (allowlist.size === 0) return false
  const emailKey = email?.trim().toLowerCase()
  if (emailKey && allowlist.has(emailKey)) return true
  const discordKey = discordAccountId?.trim().toLowerCase()
  if (discordKey && allowlist.has(discordKey)) return true
  return false
}

export function flyAppNameForMachine({ userId }: { userId: string }) {
  const shortId =
    userId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || 'user'
  const suffixBytes = new Uint8Array(4)
  crypto.getRandomValues(suffixBytes)
  const suffix = Array.from(suffixBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `kimaki-cloud-${shortId}-${suffix}`
}

export function isFlyMissing<T>(result: FlyResult<T>) {
  return result instanceof FlyNotFoundError
}

export function flyCleanupFailed<T>(
  result: FlyResult<T>,
): result is Extract<FlyResult<T>, Error> {
  return result instanceof Error && !isFlyMissing(result)
}

export function flyReachableUrl({ appName }: { appName: string }) {
  return `https://${appName}.fly.dev`
}

export function flyMachineEnv({
  appName,
  clientId,
}: {
  appName: string
  clientId: string
}) {
  return {
    NODE_ENV: 'production',
    KIMAKI_CLOUD_FLY_APP: appName,
    KIMAKI_CLOUD_CLIENT_ID: clientId,
    KIMAKI_LOCK_PORT: '8080',
    KIMAKI_SCALE_TO_ZERO: '1',
  }
}

export function flyMachineSecrets({
  clientId,
  clientSecret,
}: {
  clientId: string
  clientSecret: string
}) {
  return {
    KIMAKI_BOT_TOKEN: `${clientId}:${clientSecret}`,
  }
}

export function formatAlwaysOnComputeLabel({ compute }: { compute: number }) {
  return `$${compute.toFixed(2)}/mo if always on`
}
