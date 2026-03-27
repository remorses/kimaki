import './globals.css'

import { Suspense } from 'react'

import { Spiceflow } from 'spiceflow'
import { Head, ProgressBar } from 'spiceflow/react'

import { traceExamples } from './fake-data'
import { TraceExplorerClient } from './trace-explorer-client'

export const app = new Spiceflow()
  .layout('/*', async ({ children }) => {
    return (
      <html lang="en">
        <Head>
          <Head.Title>Better Stack Traces Recreation</Head.Title>
        </Head>
        <body>
          <ProgressBar />
          <Suspense fallback={<LoadingState />}>{children}</Suspense>
        </body>
      </html>
    )
  })
  .page('/', async function Home() {
    return <TraceExplorerClient traces={traceExamples} />
  })

function LoadingState() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--app-bg)] px-6 py-12">
      <div className="rounded border border-elevation-4 bg-white px-6 py-4 text-sm text-secondary shadow-elevation-3">
        Loading trace surface...
      </div>
    </div>
  )
}

app.listen(Number(process.env.PORT || 3000))
