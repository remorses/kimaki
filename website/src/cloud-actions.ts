'use server'

// Dashboard form actions. Server actions are public POST endpoints: each one
// reads the better-auth session and only touches machines of that user.

import { env as workerEnv } from 'cloudflare:workers'
import { getActionRequest, parseFormData, redirect } from 'spiceflow'
import { z } from 'zod'
import { createPrisma } from 'db/src'
import { getSession } from './auth.js'
import {
  CLOUD_REGIONS,
  createFlyClient,
  flyCleanupFailed,
  isCloudProvisionAllowed,
  parseCloudProvisionAllowlist,
  pauseMachine,
  provisionMachine,
  resumeMachine,
} from './cloud-service.js'
import type { Env } from './env.js'
import { deleteGatewayClientsForClientId } from './gateway-client-kv.js'

const env = workerEnv as Env

const createSchema = z.object({
  region: z.string().refine((code) => CLOUD_REGIONS.some((region) => region.code === code), 'Unknown region'),
  cpus: z.coerce.number().int().min(1).max(8),
  memory_mb: z.coerce.number().int().min(256).max(8192),
  disk_size_gb: z.coerce.number().int().min(5).max(50),
})

const machineSchema = z.object({ machine_id: z.uuid() })

async function context() {
  const session = await getSession({ env, request: getActionRequest() })
  if (!session) throw new Error('Not signed in. Open https://kimaki.dev/dashboard to sign in with Discord.')
  if (!env.FLY_API_TOKEN) throw new Error('FLY_API_TOKEN is not configured')
  return { session, prisma: createPrisma(env.HYPERDRIVE.connectionString), fly: createFlyClient(env.FLY_API_TOKEN) }
}

async function ownedMachine(formData: FormData) {
  const { session, prisma, fly } = await context()
  const { machine_id } = parseFormData(machineSchema, formData)
  const machine = await prisma.cloud_machines.findFirst({ where: { id: machine_id, user_id: session.user.id } })
  if (!machine) throw new Error('Machine not found')
  return { prisma, fly, machine }
}

export async function createMachine(formData: FormData) {
  const { session, prisma, fly } = await context()
  const input = parseFormData(createSchema, formData)
  // TODO: remove when billing exists. Temporary unpaid-provisioning gate.
  const discord = await prisma.account.findFirst({ where: { userId: session.user.id, providerId: 'discord' }, select: { accountId: true } })
  const allowed = isCloudProvisionAllowed({
    allowlist: parseCloudProvisionAllowlist(env.CLOUD_PROVISION_ALLOWLIST),
    email: session.user.email,
    discordAccountId: discord?.accountId,
  })
  if (!allowed) throw new Error('Kimaki Cloud is invite-only for now. Ask Tommy to add your Discord user id or email to CLOUD_PROVISION_ALLOWLIST.')
  const machineId = await provisionMachine({
    fly,
    prisma,
    userId: session.user.id,
    spec: { region: input.region, cpus: input.cpus, memoryMb: input.memory_mb, diskSizeGb: input.disk_size_gb },
  })
  if (machineId instanceof Error) throw machineId
  throw redirect(`/dashboard/machines/${machineId}`)
}

export async function resumeMachineAction(formData: FormData) {
  const resumed = await resumeMachine(await ownedMachine(formData))
  if (resumed instanceof Error) throw resumed
}

export async function pauseMachineAction(formData: FormData) {
  const paused = await pauseMachine(await ownedMachine(formData))
  if (paused instanceof Error) throw paused
}

// The row stays with the error when Fly keeps the app: the VM may still bill.
export async function deleteMachine(formData: FormData) {
  const { prisma, fly, machine } = await ownedMachine(formData)
  const deleted = await fly.App.deleteApp(machine.fly_app_name, { force: true })
  if (flyCleanupFailed(deleted)) {
    const message = `Fly could not delete ${machine.fly_app_name}: ${deleted.message}`
    await prisma.cloud_machines.update({ where: { id: machine.id }, data: { status: 'error', error_message: message } })
    throw new Error(message)
  }
  const clients = await deleteGatewayClientsForClientId({ env, prisma, clientId: machine.client_id })
  if (clients instanceof Error) throw clients
  await prisma.cloud_machines.delete({ where: { id: machine.id } })
  throw redirect('/dashboard')
}
