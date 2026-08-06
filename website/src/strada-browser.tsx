// Browser-side Strada init for docs/marketing pages.
// Side-effect client module: render <StradaBrowser /> once so the chunk
// evaluates in the browser (RSC bare imports are tree-shaken).

'use client'

import { initStrada, captureException } from '@strada.sh/sdk'
import { setReactErrorHandlers } from 'spiceflow/react'

// Public project id (safe to ship). Same Strada project as the Worker.
const STRADA_PROJECT_ID = '01KYX3X6FEBBV5JV6Q8M97988C'

if (typeof window !== 'undefined' && STRADA_PROJECT_ID) {
  initStrada({
    projectId: STRADA_PROJECT_ID,
    service: 'kimaki-website-browser',
    environment: import.meta.env.MODE || 'production',
    enabled: !import.meta.hot,
  })

  setReactErrorHandlers({
    onCaughtError: (error) =>
      captureException(error, { tags: { reactHandler: 'onCaughtError' } }),
    onUncaughtError: (error) =>
      captureException(error, { tags: { reactHandler: 'onUncaughtError' } }),
    onRecoverableError: (error) =>
      captureException(error, {
        tags: { reactHandler: 'onRecoverableError' },
      }),
  })
}

export function StradaBrowser() {
  return null
}
