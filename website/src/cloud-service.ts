// Kimaki Cloud service layer.
// Wraps @fly.io/sdk for machine lifecycle and provides pricing/region constants.
// Also constructs the Discord install URL for gateway onboarding (same formula
// as cli/src/utils.ts generateDiscordInstallUrlForBot, duplicated here to avoid
// importing the CLI package which would bloat the CF Worker bundle).

import { createClient } from '@fly.io/sdk'

// Same as cli/src/utils.ts KIMAKI_GATEWAY_APP_ID
const KIMAKI_GATEWAY_APP_ID = '1477605701202481173'

// Same permissions as cli/src/utils.ts and auth.ts
const DISCORD_BOT_PERMISSIONS = 17927465446480

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
// Same formula as cli/src/utils.ts generateDiscordInstallUrlForBot in gateway mode.
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
