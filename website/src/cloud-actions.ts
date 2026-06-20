// Server actions for Kimaki Cloud machine lifecycle.
// Each action authenticates via getActionRequest() + better-auth session
// because server actions are public POST endpoints.
//
// Machine creation flow:
// 1. Generate clientId + clientSecret
// 2. Create Fly app (kimaki-cloud-{shortUserId})
// 3. Create Fly volume in chosen region
// 4. Create Fly machine with Docker image, volume mount, env vars
// 5. Insert cloud_machines row (status: awaiting_authorization)
// 6. Insert gateway_clients row so gateway-proxy can route events
// 7. Redirect to machine detail page (shows Discord install URL)

import { getActionRequest, parseFormData } from 'spiceflow'
import { z } from 'zod'
import { createPrisma } from 'db/src'
import { createAuth } from './auth.js'
import { createFlyClient, CLOUD_REGIONS, type CloudRegionCode } from './cloud-service.js'
import { upsertGatewayClientAndRefreshKv } from './gateway-client-kv.js'
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

export function createCloudActions(env: Env) {
  async function createMachine(formData: FormData) {
    'use server'
    const request = getActionRequest()
    const session = await requireSession(env, request)
    const input = parseFormData(createMachineSchema, formData)
    const region = input.region as CloudRegionCode

    if (!env.FLY_API_TOKEN) {
      throw new Error('Fly.io API token not configured')
    }

    const fly = createFlyClient(env.FLY_API_TOKEN)
    const prisma = createPrisma(env.HYPERDRIVE.connectionString)

    const clientId = crypto.randomUUID()
    const clientSecret = generateSecret(32)

    // Short user ID suffix for the Fly app name (first 8 chars of UUID)
    const shortId = session.user.id.replace(/-/g, '').slice(0, 8)
    const appName = `kimaki-cloud-${shortId}`

    // Create Fly app
    const appResult = await fly.App.createApp({
      name: appName,
      org_slug: KIMAKI_FLY_ORG,
    })
    if (appResult instanceof Error) {
      throw new Error(`Failed to create Fly app: ${appResult.message}`)
    }

    let flyMachineId: string | undefined
    let flyVolumeId: string | undefined

    try {
      // Create volume
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

      // Create machine.
      // Volume is mounted at /root so the entire home directory persists across
      // image updates. Kimaki, opencode, and agent tools are installed into the
      // volume on first boot by kimaki-init.sh, not baked into the image.
      const machineResult = await fly.Machine.createMachine({
        app_name: appName,
        name: 'kimaki',
        region,
        config: {
          image: DOCKER_IMAGE,
          env: {
            NODE_ENV: 'production',
            KIMAKI_CLOUD_CLIENT_ID: clientId,
            KIMAKI_CLOUD_CLIENT_SECRET: clientSecret,
            KIMAKI_CLOUD_FLY_APP: appName,
          },
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

      // Insert gateway_clients row so the gateway-proxy can route events
      // once the user authorizes. reachable_url enables the wake mechanism.
      const upsertResult = await upsertGatewayClientAndRefreshKv({
        env,
        clientId,
        secret: clientSecret,
        guildId: 'pending', // placeholder until Discord auth
        platform: 'discord',
        userId: session.user.id,
        reachableUrl: `https://${appName}.fly.dev`,
      })
      if (upsertResult instanceof Error) {
        throw new Error(`Failed to register gateway client: ${upsertResult.message}`)
      }

      // Insert cloud_machines row
      await prisma.cloud_machines.create({
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
    } catch (error) {
      // Cleanup on failure: try to delete the Fly app (cascade deletes machine + volume)
      await fly.App.deleteApp(appName).catch(() => {})
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

    // Stop machine first if running
    if (machine.fly_machine_id) {
      await fly.Machine.stopMachine({
        app_name: machine.fly_app_name,
        machine_id: machine.fly_machine_id,
      }).catch(() => {})

      // Wait for stop, then delete machine
      await fly.Machine.waitMachine({
        app_name: machine.fly_app_name,
        machine_id: machine.fly_machine_id,
        state: 'stopped' as any,
        timeout: 30,
      }).catch(() => {})

      await fly.Machine.deleteMachine({
        app_name: machine.fly_app_name,
        machine_id: machine.fly_machine_id,
      }).catch(() => {})
    }

    // Delete volume
    if (machine.fly_volume_id) {
      await fly.Volume.deleteVolume({
        app_name: machine.fly_app_name,
        volume_id: machine.fly_volume_id,
      }).catch(() => {})
    }

    // Delete Fly app (cleanup)
    await fly.App.deleteApp(machine.fly_app_name).catch(() => {})

    // Delete gateway_clients row
    if (machine.guild_id) {
      await prisma.gateway_clients.deleteMany({
        where: { client_id: machine.client_id, guild_id: machine.guild_id },
      }).catch(() => {})
    }

    // Delete cloud_machines row
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
