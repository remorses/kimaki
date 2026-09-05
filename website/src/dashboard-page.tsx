// Dashboard pages for Kimaki Cloud.
// Lists, creates, and manages Fly.io machines provisioned for users.
// Uses Spiceflow RSC with server actions for all mutations.

import { Link } from 'spiceflow/react'
import { Head } from 'spiceflow/react'
import { SignOutButton } from './components/sign-out-button.tsx'
import { CLOUD_REGIONS, estimateMonthlyCost } from './cloud-service.js'

// Minimal type matching the cloud_machines Prisma model.
// Using a local interface avoids importing the generated Prisma client
// which can have resolution issues across workerd/node environments.
interface CloudMachine {
  id: string
  user_id: string
  fly_app_name: string
  fly_machine_id: string | null
  fly_volume_id: string | null
  region: string
  cpu_kind: string
  cpus: number
  memory_mb: number
  disk_size_gb: number
  status: string
  client_id: string
  client_secret: string
  guild_id: string | null
  error_message: string | null
  created_at: Date
  updated_at: Date
}

// Status badge colors
function statusColor(status: string) {
  switch (status) {
    case 'running':
      return 'bg-success/10 text-green-700'
    case 'stopped':
      return 'bg-muted text-muted-foreground'
    case 'creating':
    case 'awaiting_authorization':
      return 'bg-amber-50 text-amber-700'
    case 'error':
      return 'bg-red-50 text-red-700'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

function statusLabel(status: string) {
  switch (status) {
    case 'awaiting_authorization':
      return 'Awaiting auth'
    default:
      return status.charAt(0).toUpperCase() + status.slice(1)
  }
}

export function DashboardLayout({
  children,
  userName,
}: {
  children: React.ReactNode
  userName: string
}) {
  return (
    <html lang="en">
      <Head>
        <Head.Meta name="viewport" content="width=device-width, initial-scale=1" />
        <Head.Link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <Head.Link href="/src/globals.css" rel="stylesheet" />
      </Head>
      <body
        className="min-h-screen bg-background text-foreground antialiased"
        style={{ fontFamily: "'Inter', system-ui, sans-serif" }}
      >
        <header className="border-b border-border">
          <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
            <Link href="/dashboard" className="flex items-center gap-2">
              {/* Light mode logo */}
              <img
                src="/holocron-api/ai-logo/kimaki.jpeg"
                alt="Kimaki"
                className="h-5 w-auto dark:hidden"
                style={{ mixBlendMode: 'multiply' }}
              />
              {/* Dark mode logo */}
              <img
                src="/holocron-api/ai-logo/kimaki.jpeg"
                alt="Kimaki"
                className="hidden h-5 w-auto dark:block"
                style={{ mixBlendMode: 'screen', filter: 'invert(1)' }}
              />

            </Link>
            <div className="flex items-center gap-4">
              <span className="text-sm text-muted-foreground">{userName}</span>
              <SignOutButton />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
      </body>
    </html>
  )
}

export function MachineListPage({
  machines,
}: {
  machines: CloudMachine[]
}) {
  return (
    <>
      <Head>
        <Head.Title>Machines - Kimaki Cloud</Head.Title>
      </Head>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Machines</h1>
        <Link
          href="/dashboard/create"
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Create machine
        </Link>
      </div>

      {machines.length === 0 ? (
        <div className="mt-16 flex flex-col items-center gap-3 text-center text-balance">
          <p className="text-sm text-muted-foreground">
            No machines yet. Create one to run Kimaki in the cloud.
          </p>
        </div>
      ) : (
        <div className="mt-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="pb-3 font-medium">Name</th>
                <th className="pb-3 font-medium">Region</th>
                <th className="pb-3 font-medium">Specs</th>
                <th className="pb-3 font-medium">Status</th>
                <th className="pb-3 font-medium text-right">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {machines.map((machine) => {
                const region = CLOUD_REGIONS.find((r) => r.code === machine.region)
                const cost = estimateMonthlyCost({
                  cpus: machine.cpus,
                  memoryMb: machine.memory_mb,
                  diskSizeGb: machine.disk_size_gb,
                })
                return (
                  <tr key={machine.id} className="border-b border-border last:border-0">
                    <td className="py-3">
                      <Link
                        href={`/dashboard/machines/${machine.id}`}
                        className="font-medium hover:underline"
                      >
                        {machine.fly_app_name}
                      </Link>
                    </td>
                    <td className="py-3 text-muted-foreground">
                      {region?.label ?? machine.region}
                    </td>
                    <td className="py-3 text-muted-foreground">
                      {machine.cpus} vCPU · {machine.memory_mb} MB · {machine.disk_size_gb} GB
                    </td>
                    <td className="py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(machine.status)}`}
                      >
                        {statusLabel(machine.status)}
                      </span>
                    </td>
                    <td className="py-3 text-right text-muted-foreground">
                      ${cost.total}/mo
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

export function CreateMachinePage({
  createAction,
}: {
  createAction: (formData: FormData) => Promise<void>
}) {
  return (
    <>
      <Head>
        <Head.Title>Create Machine - Kimaki Cloud</Head.Title>
      </Head>
      <div className="max-w-lg">
        <h1 className="text-xl font-semibold tracking-tight">Create machine</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Deploy a managed Kimaki instance on Fly.io.
        </p>

        <form action={createAction} className="mt-8 flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="region" className="text-sm font-medium">
              Region
            </label>
            <select
              id="region"
              name="region"
              defaultValue="iad"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {CLOUD_REGIONS.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="cpus" className="text-sm font-medium">
              CPU (shared vCPUs)
            </label>
            <select
              id="cpus"
              name="cpus"
              defaultValue="1"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="1">1 vCPU</option>
              <option value="2">2 vCPUs</option>
              <option value="4">4 vCPUs</option>
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="memory_mb" className="text-sm font-medium">
              Memory
            </label>
            <select
              id="memory_mb"
              name="memory_mb"
              defaultValue="512"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="256">256 MB</option>
              <option value="512">512 MB</option>
              <option value="1024">1 GB</option>
              <option value="2048">2 GB</option>
              <option value="4096">4 GB</option>
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="disk_size_gb" className="text-sm font-medium">
              Disk size
            </label>
            <select
              id="disk_size_gb"
              name="disk_size_gb"
              defaultValue="5"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="5">5 GB</option>
              <option value="10">10 GB</option>
              <option value="20">20 GB</option>
              <option value="50">50 GB</option>
            </select>
          </div>

          <div className="mt-2 flex items-center justify-between">
            <Link href="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
              Cancel
            </Link>
            <button
              type="submit"
              className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Create machine
            </button>
          </div>
        </form>
      </div>
    </>
  )
}

export function MachineDetailPage({
  machine,
  installUrl,
  actions,
}: {
  machine: CloudMachine
  installUrl: string | null
  actions: {
    startMachine: (formData: FormData) => Promise<void>
    stopMachine: (formData: FormData) => Promise<void>
    deleteMachine: (formData: FormData) => Promise<void>
  }
}) {
  const region = CLOUD_REGIONS.find((r) => r.code === machine.region)
  const cost = estimateMonthlyCost({
    cpus: machine.cpus,
    memoryMb: machine.memory_mb,
    diskSizeGb: machine.disk_size_gb,
  })

  const isRunning = machine.status === 'running'
  const isStopped = machine.status === 'stopped'

  return (
    <>
      <Head>
        <Head.Title>{`${machine.fly_app_name} - Kimaki Cloud`}</Head.Title>
      </Head>
      <div className="flex items-center gap-3">
        <Link href="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
          ← Machines
        </Link>
      </div>

      <div className="mt-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{machine.fly_app_name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {region?.label ?? machine.region} · {machine.cpus} vCPU · {machine.memory_mb} MB · {machine.disk_size_gb} GB disk
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${statusColor(machine.status)}`}
          >
            {statusLabel(machine.status)}
          </span>
          {isStopped ? (
            <form action={actions.startMachine}>
              <input type="hidden" name="machine_id" value={machine.id} />
              <button
                type="submit"
                className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium transition-colors hover:bg-accent"
              >
                Start
              </button>
            </form>
          ) : null}
          {isRunning ? (
            <form action={actions.stopMachine}>
              <input type="hidden" name="machine_id" value={machine.id} />
              <button
                type="submit"
                className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium transition-colors hover:bg-accent"
              >
                Stop
              </button>
            </form>
          ) : null}
        </div>
      </div>

      {machine.status === 'awaiting_authorization' && installUrl ? (
        <div className="mt-8 rounded-lg border border-border p-6">
          <h2 className="text-sm font-semibold">Authorize the Kimaki bot</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Click below to add the Kimaki bot to your Discord server.
            After authorizing, the machine will connect automatically.
          </p>
          <a
            href={installUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex h-9 items-center rounded-md bg-[#5865F2] px-4 text-sm font-medium text-white transition-colors hover:bg-[#4752C4]"
          >
            Authorize on Discord
          </a>
        </div>
      ) : null}

      {machine.error_message ? (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">{machine.error_message}</p>
        </div>
      ) : null}

      <div className="mt-8 border-t border-border pt-6">
        <h2 className="text-sm font-semibold">Estimated cost</h2>
        <div className="mt-3 flex gap-8 text-sm">
          <div>
            <div className="text-muted-foreground">Compute (24/7)</div>
            <div className="mt-0.5 font-medium">${cost.compute}/mo</div>
          </div>
          <div>
            <div className="text-muted-foreground">Storage</div>
            <div className="mt-0.5 font-medium">${cost.storage}/mo</div>
          </div>
          <div>
            <div className="text-muted-foreground">Total</div>
            <div className="mt-0.5 font-medium">${cost.total}/mo</div>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          With scale-to-zero, you only pay for compute when active. Storage is always charged.
        </p>
      </div>

      <div className="mt-8 border-t border-border pt-6">
        <h2 className="text-sm font-semibold text-destructive">Danger zone</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Permanently delete this machine, its volume, and all data.
        </p>
        <form action={actions.deleteMachine} className="mt-3">
          <input type="hidden" name="machine_id" value={machine.id} />
          <button
            type="submit"
            className="inline-flex h-8 items-center rounded-md border border-destructive/30 px-3 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
          >
            Delete machine
          </button>
        </form>
      </div>
    </>
  )
}
