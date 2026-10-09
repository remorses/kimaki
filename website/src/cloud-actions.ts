// Server actions for Kimaki Cloud machine lifecycle.
// Each action authenticates via getActionRequest() + better-auth session
// because server actions are public POST endpoints.
//
// Machine creation flow:
// 1. Check CLOUD_PROVISION_ALLOWLIST (Discord user id or email). TODO: remove when billing exists.
// 2. Generate clientId + clientSecret
// 3. Create Fly app (kimaki-cloud-{shortUserId}-{random}) on its own private network,
//    with a shared IPv4 and an IPv6 so <app>.fly.dev routes to it
// 4. Store client secret as Fly secrets, not machine env
// 5. Create Fly volume in chosen region
// 6. Create Fly machine with skip_launch. Booting before Discord OAuth makes
//    gateway-proxy reject the token and kimaki exit 64 into a Fly restart loop.
// 7. Insert cloud_machines row (status: awaiting_authorization)
// 8. Redirect to machine detail page (shows Discord install URL)
// gateway_clients is written on Discord OAuth, not here. There is no guild yet.
// The OAuth callback starts the machine after the real guild row exists.

import { AddressType, ApiMachineRestartPolicyEnum } from '@fly.io/sdk'
import { getActionRequest, parseFormData } from 'spiceflow'
import { z } from 'zod'
import { createPrisma } from 'db/src'
import { createAuth } from './auth.js'
import {
  createFlyClient,
  CLOUD_REGIONS,
  flyAppNameForMachine,
  flyCleanupFailed,
  flyMachineEnv,
  flyMachineSecrets,
  flyReachableUrl,
  isCloudProvisionAllowed,
  parseCloudProvisionAllowlist,
  type CloudRegionCode,
} from './cloud-service.js'
import { deleteGatewayClientsForClientId } from './gateway-client-kv.js'
import type { Env } from './env.js'

const DOCKER_IMAGE = 'registry.fly.io/kimaki-cloud:latest'
const KIMAKI_FLY_ORG = 'kimaki-cloud'

const createMachineSchema = z.object({
  region: z.enum(CLOUD_REGIONS.map((r) => r.code) as [string, ...string[]]),
  cpus: z.coerce.number().int().min(1).max(8),
  memory_mb: z.coerce.number().int().min(256).max(8192),
  disk_size_gb: z.coerce.number().int().min(5).max(50),
})

function generateSecret(bytes: number): string {
  const array = new Uint8Array(bytes)
  crypto.getRandomValues(array)
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function requireSession(env: Env, request: Request) {
  const baseURL = new URL(request.url).origin
  const auth = createAuth({ env, baseURL })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) {
    throw new Error('Not authenticated')
  }
  return session
}

async function requireCloudProvisionAccess({
  env,
  userId,
  email,
}: {
  env: Env
  userId: string
  email?: string | null
}) {
  const prisma = createPrisma(env.HYPERDRIVE.connectionString)
  const discordAccount = await prisma.account.findFirst({
    where: { userId, providerId: 'discord' },
    select: { accountId: true },
  })
  // TODO: remove when billing exists. Temporary unpaid-provisioning gate.
  const allowed = isCloudProvisionAllowed({
    allowlist: parseCloudProvisionAllowlist(env.CLOUD_PROVISION_ALLOWLIST),
    email,
    discordAccountId: discordAccount?.accountId,
  })
  if (!allowed) {
    throw new Error(
      'Kimaki Cloud provisioning is limited to an allowlist. Ask Tommy to add your Discord user id or email to CLOUD_PROVISION_ALLOWLIST.',
    )
  }
}

export function createCloudActions(env: Env) {
  async function createMachine(formData: FormData) {
    'use server'
    const request = getActionRequest()
    const session = await requireSession(env, request)
    await requireCloudProvisionAccess({
      env,
      userId: session.user.id,
      email: session.user.email,
    })
    const input = parseFormData(createMachineSchema, formData)
    const region = input.region as CloudRegionCode

    if (!env.FLY_API_TOKEN) {
      throw new Error('Fly.io API token not configured')
    }

    const fly = createFlyClient(env.FLY_API_TOKEN)
    const prisma = createPrisma(env.HYPERDRIVE.connectionString)

    const clientId = crypto.randomUUID()
    const clientSecret = generateSecret(32)
    const appName = flyAppNameForMachine({ userId: session.user.id })

    const appResult = await fly.App.createApp({
      name: appName,
      org_slug: KIMAKI_FLY_ORG,
      // Own private network: agents on one tenant's VM cannot reach other tenants' VMs.
      network: appName,
    })
    if (appResult instanceof Error) {
      throw new Error(`Failed to create Fly app: ${appResult.message}`)
    }

    let flyMachineId: string | undefined
    let flyVolumeId: string | undefined

    try {
      // API-created apps get no public IP: <app>.fly.dev (the wake URL) needs one.
      // https://fly.io/docs/machines/api/apps-resource/#allocate-an-ip-address-for-global-request-routing
      for (const type of [AddressType.shared_v4, AddressType.v6]) {
        const allocated = await fly.Network.allocateIpAddress({ appId: appName, type })
        if (allocated instanceof Error) {
          throw new Error(`Failed to allocate a ${type} IP: ${allocated.message}`)
        }
      }

      const secretsResult = await fly.App.updateSecrets({
        app_name: appName,
        request: {
          values: flyMachineSecrets({ clientId, clientSecret }),
        },
      })
      if (secretsResult instanceof Error) {
        throw new Error(`Failed to store Fly secrets: ${secretsResult.message}`)
      }

      const volumeResult = await fly.Volume.createVolume({
        app_name: appName,
        name: 'kimaki_data',
        region,
        size_gb: input.disk_size_gb,
      })
      if (volumeResult instanceof Error) {
        throw new Error(`Failed to create volume: ${volumeResult.message}`)
      }
      flyVolumeId = volumeResult.id

      const machineResult = await fly.Machine.createMachine({
        app_name: appName,
        name: 'kimaki',
        region,
        skip_launch: true,
        min_secrets_version: secretsResult.version,
        config: {
          image: DOCKER_IMAGE,
          env: flyMachineEnv({ appName, clientId }),
          // Scale-to-zero exits with code 0: the VM must stay stopped until the next wake.
          restart: { policy: ApiMachineRestartPolicyEnum.OnFailure },
          guest: {
            cpu_kind: 'shared',
            cpus: input.cpus,
            memory_mb: input.memory_mb,
          },
          mounts: [
            {
              volume: flyVolumeId,
              path: '/root',
            },
          ],
          services: [
            {
              protocol: 'tcp',
              internal_port: 8080,
              autostart: true,
              autostop: 'off',
              ports: [
                { port: 443, handlers: ['tls', 'http'] },
                { port: 80, handlers: ['http'] },
              ],
            },
          ],
        },
      })
      if (machineResult instanceof Error) {
        throw new Error(`Failed to create machine: ${machineResult.message}`)
      }
      flyMachineId = machineResult.id

      const created = await prisma.cloud_machines.create({
        data: {
          user_id: session.user.id,
          fly_app_name: appName,
          fly_machine_id: flyMachineId,
          fly_volume_id: flyVolumeId,
          region,
          cpu_kind: 'shared',
          cpus: input.cpus,
          memory_mb: input.memory_mb,
          disk_size_gb: input.disk_size_gb,
          status: 'awaiting_authorization',
          client_id: clientId,
          client_secret: clientSecret,
        },
      })
      return created.id
    } catch (error) {
      const deleted = await fly.App.deleteApp(appName, { force: true })
      if (flyCleanupFailed(deleted)) {
        throw new Error(
          `Provisioning failed and Fly app ${appName} was not deleted: ${deleted.message}`,
          { cause: error },
        )
      }
      throw error
    }
  }

  async function startMachine(formData: FormData) {
    'use server'
    const request = getActionRequest()
    const session = await requireSession(env, request)
    const machineId = formData.get('machine_id') as string
    if (!machineId || !env.FLY_API_TOKEN) throw new Error('Missing params')

    const prisma = createPrisma(env.HYPERDRIVE.connectionString)
    const machine = await prisma.cloud_machines.findFirst({
      where: { id: machineId, user_id: session.user.id },
    })
    if (!machine || !machine.fly_machine_id) throw new Error('Machine not found')

    const fly = createFlyClient(env.FLY_API_TOKEN)
    const result = await fly.Machine.startMachine({
      app_name: machine.fly_app_name,
      machine_id: machine.fly_machine_id,
    })
    if (result instanceof Error) throw new Error(`Failed to start: ${result.message}`)

    await prisma.gateway_clients.updateMany({
      where: { client_id: machine.client_id },
      data: { reachable_url: flyReachableUrl({ appName: machine.fly_app_name }) },
    })
    await prisma.cloud_machines.updateMany({
      where: { id: machineId, user_id: session.user.id },
      data: { status: 'running' },
    })
  }

  async function stopMachine(formData: FormData) {
    'use server'
    const request = getActionRequest()
    const session = await requireSession(env, request)
    const machineId = formData.get('machine_id') as string
    if (!machineId || !env.FLY_API_TOKEN) throw new Error('Missing params')

    const prisma = createPrisma(env.HYPERDRIVE.connectionString)
    const machine = await prisma.cloud_machines.findFirst({
      where: { id: machineId, user_id: session.user.id },
    })
    if (!machine || !machine.fly_machine_id) throw new Error('Machine not found')

    const fly = createFlyClient(env.FLY_API_TOKEN)
    const result = await fly.Machine.stopMachine({
      app_name: machine.fly_app_name,
      machine_id: machine.fly_machine_id,
    })
    if (result instanceof Error) throw new Error(`Failed to stop: ${result.message}`)

    await prisma.gateway_clients.updateMany({
      where: { client_id: machine.client_id },
      data: { reachable_url: null },
    })
    await prisma.cloud_machines.updateMany({
      where: { id: machineId, user_id: session.user.id },
      data: { status: 'stopped' },
    })
  }

  async function deleteMachine(formData: FormData) {
    'use server'
    const request = getActionRequest()
    const session = await requireSession(env, request)
    const machineId = formData.get('machine_id') as string
    if (!machineId || !env.FLY_API_TOKEN) throw new Error('Missing params')

    const prisma = createPrisma(env.HYPERDRIVE.connectionString)
    const machine = await prisma.cloud_machines.findFirst({
      where: { id: machineId, user_id: session.user.id },
    })
    if (!machine) throw new Error('Machine not found')

    const fly = createFlyClient(env.FLY_API_TOKEN)
    const deletedApp = await fly.App.deleteApp(machine.fly_app_name, { force: true })
    if (flyCleanupFailed(deletedApp)) {
      const errorMessage = `Fly cleanup failed: ${deletedApp.message}`
      await prisma.cloud_machines.update({
        where: { id: machineId },
        data: { status: 'error', error_message: errorMessage },
      })
      throw new Error(errorMessage)
    }

    const deletedClients = await deleteGatewayClientsForClientId({
      env,
      prisma,
      clientId: machine.client_id,
    })
    if (deletedClients instanceof Error) {
      throw new Error(`Failed to delete gateway clients: ${deletedClients.message}`)
    }

    await prisma.cloud_machines.delete({ where: { id: machineId } })
  }

  async function scaleMachine(formData: FormData) {
    'use server'
    const request = getActionRequest()
    const session = await requireSession(env, request)
    const machineId = formData.get('machine_id') as string
    const cpus = Number(formData.get('cpus'))
    const memoryMb = Number(formData.get('memory_mb'))
    if (!machineId || !cpus || !memoryMb || !env.FLY_API_TOKEN) throw new Error('Missing params')

    const prisma = createPrisma(env.HYPERDRIVE.connectionString)
    const machine = await prisma.cloud_machines.findFirst({
      where: { id: machineId, user_id: session.user.id },
    })
    if (!machine || !machine.fly_machine_id) throw new Error('Machine not found')

    const fly = createFlyClient(env.FLY_API_TOKEN)

    // Get current machine config to preserve other settings
    const current = await fly.Machine.getMachine({
      app_name: machine.fly_app_name,
      machine_id: machine.fly_machine_id,
    })
    if (current instanceof Error) throw new Error(`Failed to get machine: ${current.message}`)

    const result = await fly.Machine.updateMachine({
      app_name: machine.fly_app_name,
      machine_id: machine.fly_machine_id,
      config: {
        ...current.config,
        guest: {
          ...current.config?.guest,
          cpu_kind: 'shared',
          cpus,
          memory_mb: memoryMb,
        },
      },
    })
    if (result instanceof Error) throw new Error(`Failed to scale: ${result.message}`)

    await prisma.cloud_machines.updateMany({
      where: { id: machineId, user_id: session.user.id },
      data: { cpus, memory_mb: memoryMb },
    })
  }

  async function extendDisk(formData: FormData) {
    'use server'
    const request = getActionRequest()
    const session = await requireSession(env, request)
    const machineId = formData.get('machine_id') as string
    const newSizeGb = Number(formData.get('disk_size_gb'))
    if (!machineId || !newSizeGb || !env.FLY_API_TOKEN) throw new Error('Missing params')

    const prisma = createPrisma(env.HYPERDRIVE.connectionString)
    const machine = await prisma.cloud_machines.findFirst({
      where: { id: machineId, user_id: session.user.id },
    })
    if (!machine || !machine.fly_volume_id) throw new Error('Machine not found')

    if (newSizeGb <= machine.disk_size_gb) {
      throw new Error('New size must be larger than current size (volumes can only grow)')
    }

    const fly = createFlyClient(env.FLY_API_TOKEN)
    const result = await fly.Volume.extendVolume({
      app_name: machine.fly_app_name,
      volume_id: machine.fly_volume_id,
      size_gb: newSizeGb,
    })
    if (result instanceof Error) throw new Error(`Failed to extend disk: ${result.message}`)

    await prisma.cloud_machines.updateMany({
      where: { id: machineId, user_id: session.user.id },
      data: { disk_size_gb: newSizeGb },
    })
  }

  return { createMachine, startMachine, stopMachine, deleteMachine, scaleMachine, extendDisk }
}
