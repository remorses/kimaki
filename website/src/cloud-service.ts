// Kimaki Cloud: one managed kimaki per Fly app, connected through gateway-proxy.
//
//   provisionMachine ─▶ Fly app (own network, IPv4 + IPv6) ─▶ secret ─▶ volume ─▶ machine (not launched)
//   Discord OAuth (/discord-install?reachableUrl) ─▶ gateway_clients row ─▶ resumeMachine
//   pauseMachine: clears reachable_url and stops the VM, so nothing wakes it
//   deleteMachine (cloud-actions.ts): force-deletes the Fly app, then gateway_clients and the row
//
// While active, the VM stops itself when idle (kimaki/src/scale-to-zero.ts) and
// gateway-proxy starts it again through <app>.fly.dev/kimaki/wake.
// Operations take the Fly and Prisma clients as inputs (per-request clients, see AGENTS.md).

import {
  AddressType,
  ApiMachineRestartPolicyEnum,
  createClient,
  FlyNotFoundError,
  type FlyResult,
} from '@fly.io/sdk'
import type { PrismaClient } from 'db/src'

export const CLOUD_REGIONS = [
  { code: 'iad', label: 'US East (Virginia)' },
  { code: 'sjc', label: 'US West (San Jose)' },
  { code: 'ams', label: 'Europe (Amsterdam)' },
  { code: 'nrt', label: 'Asia (Tokyo)' },
  { code: 'syd', label: 'Oceania (Sydney)' },
  { code: 'gru', label: 'South America (São Paulo)' },
] as const

const DOCKER_IMAGE = 'registry.fly.io/kimaki-cloud:latest'
const KIMAKI_FLY_ORG = 'kimaki-cloud'
// kimaki's lock server (KIMAKI_LOCK_PORT in kimaki-cloud/kimaki-init.sh) serves /kimaki/wake.
const WAKE_PORT = 8080
// Fly default is 5, max 60. Snapshots cost $0.08/GB-month after the first 10 GB.
const SNAPSHOT_RETENTION_DAYS = 14

// Fly pricing per hour (USD), used for 2x markup display
// Source: https://fly.io/pricing/ (shared-cpu)
const FLY_SHARED_CPU_PER_HOUR = 0.0027 // per shared vCPU
const FLY_MEMORY_PER_GB_PER_HOUR = 0.006 // per GB RAM
const FLY_VOLUME_PER_GB_PER_MONTH = 0.15
const MARKUP = 2

export function estimateMonthlyCost({ cpus, memoryMb, diskSizeGb }: { cpus: number; memoryMb: number; diskSizeGb: number }) {
  const hoursPerMonth = 730
  const computePerHour = cpus * FLY_SHARED_CPU_PER_HOUR + (memoryMb / 1024) * FLY_MEMORY_PER_GB_PER_HOUR
  return {
    // Upper bound: an active machine runs only while it has work.
    alwaysOnCompute: Math.round(computePerHour * hoursPerMonth * MARKUP * 100) / 100,
    storage: Math.round(diskSizeGb * FLY_VOLUME_PER_GB_PER_MONTH * MARKUP * 100) / 100,
  }
}

// Same formula as gatewayInstallUrl in kimaki/src/credentials.ts, plus the wake URL.
// Duplicated so the Worker bundle does not import the kimaki package.
export function constructInstallUrl({ clientId, clientSecret, callbackUrl, reachableUrl, websiteOrigin }: {
  clientId: string
  clientSecret: string
  callbackUrl: string
  reachableUrl: string
  websiteOrigin: string
}) {
  const url = new URL('/discord-install', websiteOrigin)
  url.searchParams.set('clientId', clientId)
  url.searchParams.set('clientSecret', clientSecret)
  url.searchParams.set('kimakiCallbackUrl', callbackUrl)
  url.searchParams.set('reachableUrl', reachableUrl)
  return url.toString()
}

export function createFlyClient(apiToken: string) {
  return createClient({ apiKey: apiToken })
}

export type FlyClient = ReturnType<typeof createFlyClient>

// TODO: remove when billing exists. Temporary unpaid-provisioning gate.
export function parseCloudProvisionAllowlist(raw: string | undefined) {
  if (!raw) return new Set<string>()
  return new Set(raw.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean))
}

export function isCloudProvisionAllowed({ allowlist, email, discordAccountId }: {
  allowlist: Set<string>
  email?: string | null
  discordAccountId?: string | null
}) {
  return [email, discordAccountId].some((key) => {
    const normalized = key?.trim().toLowerCase()
    return Boolean(normalized && allowlist.has(normalized))
  })
}

function randomHex(bytes: number) {
  const array = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function flyAppNameForMachine({ userId }: { userId: string }) {
  const shortId = userId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || 'user'
  return `kimaki-cloud-${shortId}-${randomHex(4)}`
}

export function isFlyMissing<T>(result: FlyResult<T>) {
  return result instanceof FlyNotFoundError
}

// A 404 means the app is already gone, which is what cleanup wants.
export function flyCleanupFailed<T>(result: FlyResult<T>): result is Extract<FlyResult<T>, Error> {
  return result instanceof Error && !isFlyMissing(result)
}

export function flyReachableUrl({ appName }: { appName: string }) {
  return `https://${appName}.fly.dev`
}

// The only secret: kimaki saves it in SQLite and drops it from its env on start.
export function flyMachineSecrets({ clientId, clientSecret }: { clientId: string; clientSecret: string }) {
  return { KIMAKI_BOT_TOKEN: `${clientId}:${clientSecret}` }
}

export type MachineSpec = { region: string; cpus: number; memoryMb: number; diskSizeGb: number }

type MachineRow = { id: string; fly_app_name: string; fly_machine_id: string | null; client_id: string }

// Returns the cloud_machines id. Deletes the Fly app again when a later step fails.
export async function provisionMachine({ fly, prisma, userId, spec }: {
  fly: FlyClient
  prisma: PrismaClient
  userId: string
  spec: MachineSpec
}): Promise<Error | string> {
  const clientId = crypto.randomUUID()
  const clientSecret = randomHex(32)
  const appName = flyAppNameForMachine({ userId })
  // Own private network: an agent on one tenant's VM cannot reach another tenant's VM.
  const app = await fly.App.createApp({ name: appName, org_slug: KIMAKI_FLY_ORG, network: appName })
  if (app instanceof Error) return new Error(`Failed to create Fly app: ${app.message}`, { cause: app })

  const provisioned = await (async (): Promise<Error | string> => {
    // API-created apps get no public IP; <app>.fly.dev (the wake URL) needs one.
    // https://fly.io/docs/machines/api/apps-resource/#allocate-an-ip-address-for-global-request-routing
    for (const type of [AddressType.shared_v4, AddressType.v6]) {
      const ip = await fly.Network.allocateIpAddress({ appId: appName, type })
      if (ip instanceof Error) return new Error(`Failed to allocate a ${type} IP: ${ip.message}`, { cause: ip })
    }
    const secrets = await fly.App.updateSecrets({ app_name: appName, request: { values: flyMachineSecrets({ clientId, clientSecret }) } })
    if (secrets instanceof Error) return new Error(`Failed to store Fly secrets: ${secrets.message}`, { cause: secrets })
    const volume = await fly.Volume.createVolume({
      app_name: appName,
      name: 'kimaki_data',
      region: spec.region,
      size_gb: spec.diskSizeGb,
      // The volume lives on one host: daily snapshots are the only copy if it fails.
      // https://fly.io/docs/volumes/snapshots/
      snapshot_retention: SNAPSHOT_RETENTION_DAYS,
    })
    if (volume instanceof Error) return new Error(`Failed to create volume: ${volume.message}`, { cause: volume })
    // skip_launch: kimaki cannot log in before Discord OAuth writes the gateway_clients row.
    const machine = await fly.Machine.createMachine({
      app_name: appName,
      name: 'kimaki',
      region: spec.region,
      skip_launch: true,
      min_secrets_version: secrets.version,
      config: {
        image: DOCKER_IMAGE,
        // Scale-to-zero exits with code 0: the VM stays stopped until the next wake.
        restart: { policy: ApiMachineRestartPolicyEnum.OnFailure },
        guest: { cpu_kind: 'shared', cpus: spec.cpus, memory_mb: spec.memoryMb },
        mounts: [{ volume: volume.id, path: '/root' }],
        services: [{
          protocol: 'tcp',
          internal_port: WAKE_PORT,
          // A request to <app>.fly.dev starts a stopped VM; kimaki stops it itself.
          autostart: true,
          autostop: 'off',
          ports: [{ port: 443, handlers: ['tls', 'http'] }, { port: 80, handlers: ['http'] }],
        }],
      },
    })
    if (machine instanceof Error) return new Error(`Failed to create machine: ${machine.message}`, { cause: machine })
    const row = await prisma.cloud_machines.create({
      data: {
        user_id: userId,
        fly_app_name: appName,
        fly_machine_id: machine.id,
        fly_volume_id: volume.id,
        region: spec.region,
        cpus: spec.cpus,
        memory_mb: spec.memoryMb,
        disk_size_gb: spec.diskSizeGb,
        status: 'awaiting_authorization',
        client_id: clientId,
        client_secret: clientSecret,
      },
    }).catch((cause) => new Error('Failed to save the machine', { cause }))
    if (row instanceof Error) return row
    return row.id
  })()
  if (!(provisioned instanceof Error)) return provisioned
  const deleted = await fly.App.deleteApp(appName, { force: true })
  if (flyCleanupFailed(deleted)) return new Error(`${provisioned.message}. Fly app ${appName} was not deleted: ${deleted.message}`, { cause: provisioned })
  return provisioned
}

// Starts the VM and lets gateway-proxy wake it again.
export async function resumeMachine({ fly, prisma, machine, guildId }: {
  fly: FlyClient
  prisma: PrismaClient
  machine: MachineRow
  guildId?: string
}): Promise<Error | void> {
  if (!machine.fly_machine_id) return new Error('Machine has no Fly machine id')
  const started = await fly.Machine.startMachine({ app_name: machine.fly_app_name, machine_id: machine.fly_machine_id })
  if (started instanceof Error) return new Error(`Failed to start the machine: ${started.message}`, { cause: started })
  return prisma.$transaction([
    prisma.gateway_clients.updateMany({ where: { client_id: machine.client_id }, data: { reachable_url: flyReachableUrl({ appName: machine.fly_app_name }) } }),
    prisma.cloud_machines.update({ where: { id: machine.id }, data: { status: 'running', error_message: null, ...(guildId && { guild_id: guildId }) } }),
  ]).then(() => undefined, (cause) => new Error('Failed to save the machine status', { cause }))
}

// Clears reachable_url first: a Discord message must not wake the VM again.
export async function pauseMachine({ fly, prisma, machine }: { fly: FlyClient; prisma: PrismaClient; machine: MachineRow }): Promise<Error | void> {
  if (!machine.fly_machine_id) return new Error('Machine has no Fly machine id')
  const cleared = await prisma.gateway_clients.updateMany({ where: { client_id: machine.client_id }, data: { reachable_url: null } })
    .catch((cause) => new Error('Failed to disable wakes', { cause }))
  if (cleared instanceof Error) return cleared
  const target = { app_name: machine.fly_app_name, machine_id: machine.fly_machine_id }
  const current = await fly.Machine.getMachine(target)
  if (current instanceof Error) return new Error(`Failed to read the machine: ${current.message}`, { cause: current })
  // A VM that idled out is already stopped.
  const stopped = current.state === 'stopped' ? undefined : await fly.Machine.stopMachine(target)
  if (stopped instanceof Error) return new Error(`Failed to stop the machine: ${stopped.message}`, { cause: stopped })
  return prisma.cloud_machines.update({ where: { id: machine.id }, data: { status: 'stopped' } })
    .then(() => undefined, (cause) => new Error('Failed to save the machine status', { cause }))
}
