// Kimaki Cloud routes, mounted by server.tsx: the /dashboard pages, the Discord
// OAuth return of a machine, and /api/cloud/next-wake for the machines themselves.
// Machine operations live in cloud-service.ts, form actions in cloud-actions.ts.

import { Spiceflow } from 'spiceflow'
import { z } from 'zod'
import { createPrisma } from 'db/src'
import { createAuth, getSession } from './auth.js'
import { constructInstallUrl, createFlyClient, flyReachableUrl, resumeMachine } from './cloud-service.js'
import { CreateMachinePage, DashboardLayout, MachineDetailPage, MachineListPage } from './dashboard-page.js'
import type { Env } from './env.js'
import { reportWebsiteError } from './strada-init.js'

function jsonError(status: number, error: string) {
  return new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } })
}

export const cloudApp = new Spiceflow()
  .state('env', {} as Env)

  // A cloud machine stores its soonest local task or sleep before its idle exit
  // (kimaki/src/scale-to-zero.ts). gateway-proxy starts the VM 30s before it.
  .route({
    method: 'POST',
    path: '/api/cloud/next-wake',
    request: z.object({ next_wake_at: z.iso.datetime().nullable().optional() }),
    async handler({ request, state }) {
      const token = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
      const [clientId, clientSecret] = token.split(':')
      if (!clientId || !clientSecret) return jsonError(401, 'Authorization must be Bearer clientId:secret')
      const body = await request.json()
      const prisma = createPrisma(state.env.HYPERDRIVE.connectionString)
      const updated = await prisma.gateway_clients
        .updateMany({
          where: { client_id: clientId, secret: clientSecret },
          data: { next_wake_at: body.next_wake_at ? new Date(body.next_wake_at) : null },
        })
        .catch((cause) => new Error('Failed to update next_wake_at', { cause }))
      if (updated instanceof Error) {
        reportWebsiteError(updated, { route: '/api/cloud/next-wake' })
        return jsonError(500, 'Failed to update next wake time')
      }
      if (updated.count === 0) return jsonError(401, 'Invalid client credentials')
      return { ok: true }
    },
  })

  .route({
    method: 'POST',
    path: '/dashboard/sign-out',
    async handler({ request, state }) {
      const auth = createAuth({ env: state.env, baseURL: new URL(request.url).origin })
      const { headers } = await auth.api.signOut({ headers: request.headers, returnHeaders: true })
      const response = new Response(null, { status: 302, headers: { Location: '/dashboard' } })
      for (const cookie of headers.getSetCookie()) response.headers.append('Set-Cookie', cookie)
      return response
    },
  })

  .layout('/dashboard/*', async ({ children, request, state }) => {
    const session = await getSession({ env: state.env, request })
    if (session) return <DashboardLayout userName={session.user.name}>{children}</DashboardLayout>
    // Sign-in only needs identify + email, not the bot install scopes of the Discord provider.
    const auth = createAuth({ env: state.env, baseURL: new URL(request.url).origin })
    const { response: result, headers } = await auth.api.signInSocial({
      body: { provider: 'discord', callbackURL: new URL(request.url).pathname, scopes: ['identify', 'email'] },
      headers: request.headers,
      returnHeaders: true,
    })
    if (!result?.url) throw new Response('Failed to start Discord sign-in', { status: 500 })
    const oauthUrl = new URL(result.url)
    oauthUrl.searchParams.delete('permissions')
    // signInSocial merges the provider's default scopes.
    oauthUrl.searchParams.set('scope', 'identify email')
    const redirectResponse = new Response(null, { status: 302, headers: { Location: oauthUrl.toString() } })
    for (const cookie of headers.getSetCookie()) redirectResponse.headers.append('Set-Cookie', cookie)
    throw redirectResponse
  })

  .loader('/dashboard', async ({ state, request }) => {
    const session = await getSession({ env: state.env, request })
    if (!session) return { machines: [] }
    const prisma = createPrisma(state.env.HYPERDRIVE.connectionString)
    const machines = await prisma.cloud_machines.findMany({ where: { user_id: session.user.id }, orderBy: { created_at: 'desc' } })
    return { machines }
  })
  .page('/dashboard', async ({ loaderData }) => <MachineListPage machines={loaderData.machines} />)

  .page('/dashboard/create', async () => <CreateMachinePage />)

  .page('/dashboard/machines/:id', async ({ params, state, request, response }) => {
    const session = await getSession({ env: state.env, request })
    const prisma = createPrisma(state.env.HYPERDRIVE.connectionString)
    const machine = session && await prisma.cloud_machines.findFirst({ where: { id: params.id, user_id: session.user.id } })
    if (!machine) {
      response.status = 404
      return <p className="text-sm text-muted-foreground">Machine not found</p>
    }
    const origin = new URL(request.url).origin
    const installUrl = machine.status === 'awaiting_authorization'
      ? constructInstallUrl({
          clientId: machine.client_id,
          clientSecret: machine.client_secret,
          callbackUrl: new URL(`/dashboard/machines/${machine.id}/callback`, origin).toString(),
          reachableUrl: flyReachableUrl({ appName: machine.fly_app_name }),
          websiteOrigin: origin,
        })
      : null
    return <MachineDetailPage machine={machine} installUrl={installUrl} />
  })

  // Discord OAuth of a machine returns here. The gateway_clients row with this
  // machine's secret proves the install happened; then the VM starts for the first time.
  .route({
    method: 'GET',
    path: '/dashboard/machines/:id/callback',
    query: z.object({ guild_id: z.string().min(1) }),
    async handler({ params, query, request, state }) {
      const session = await getSession({ env: state.env, request })
      if (!session) return new Response(null, { status: 302, headers: { Location: '/dashboard' } })
      const prisma = createPrisma(state.env.HYPERDRIVE.connectionString)
      const machine = await prisma.cloud_machines.findFirst({ where: { id: params.id, user_id: session.user.id } })
      if (!machine) return new Response('Machine not found', { status: 404 })
      const installed = await prisma.gateway_clients.findFirst({
        where: { client_id: machine.client_id, guild_id: query.guild_id, secret: machine.client_secret },
      })
      if (!installed) return new Response('Authorization not completed. Try authorizing again.', { status: 409 })
      if (!state.env.FLY_API_TOKEN) return new Response('FLY_API_TOKEN is not configured', { status: 500 })
      const resumed = await resumeMachine({ fly: createFlyClient(state.env.FLY_API_TOKEN), prisma, machine, guildId: query.guild_id })
      if (resumed instanceof Error) {
        reportWebsiteError(resumed, { route: '/dashboard/machines/:id/callback' })
        return new Response(`Authorized, but ${resumed.message}`, { status: 502 })
      }
      return new Response(null, { status: 302, headers: { Location: `/dashboard/machines/${machine.id}` } })
    },
  })
