// Server-side Strada init for the Cloudflare Worker.
// Must run at module scope so OTel providers exist before request handling.

import { env } from 'cloudflare:workers'
import { initStrada, captureException, trace } from '@strada.sh/sdk'
import type { SpiceflowTracer } from 'spiceflow'
import type { Env } from './env.js'

const workerEnv = env as Env

const projectId = workerEnv.STRADA_PROJECT_ID
const token = workerEnv.STRADA_TOKEN

if (projectId && token) {
  initStrada({
    projectId,
    token,
    service: 'kimaki-website',
    environment: workerEnv.ENVIRONMENT || 'production',
  })
}

export function reportWebsiteError(
  error: unknown,
  tags?: Record<string, string>,
) {
  if (!projectId || !token) return
  try {
    captureException(error, { tags })
  } catch {
    // never break the worker for telemetry
  }
}

// OTel Tracer is structurally compatible with Spiceflow's tracer hook.
export const websiteTracer: SpiceflowTracer | undefined =
  projectId && token
    ? (trace.getTracer('kimaki-website') as unknown as SpiceflowTracer)
    : undefined
