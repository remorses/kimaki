// Debounced async callback with centralized shutdown flushing.
// Used for persistence paths that should batch writes during runtime
// while allowing the bot's single SIGTERM/SIGINT handler to flush all callbacks.

type FlushCallback = () => Promise<void>

const processFlushCallbacks = new Set<FlushCallback>()

export async function flushDebouncedProcessCallbacks(): Promise<void> {
  const callbacks = [...processFlushCallbacks]
  await Promise.allSettled(
    callbacks.map((callback) => {
      return callback()
    }),
  )
}

export function createDebouncedProcessFlush({
  waitMs,
  callback,
  onError,
}: {
  waitMs: number
  callback: () => Promise<void>
  onError?: (error: Error) => void
}): {
  trigger: () => void
  flush: () => Promise<void>
  dispose: () => Promise<void>
} {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined
  let dirty = false

  async function run(): Promise<void> {
    if (!dirty) {
      return
    }
    if (inFlight) {
      await inFlight
      if (!dirty) {
        return
      }
    }

    dirty = false
    const current = Promise.resolve()
      .then(() => {
        return callback()
      })
      .catch((error) => {
        if (onError) {
          const wrappedError =
            error instanceof Error
              ? error
              : new Error('Debounced process flush failed', { cause: error })
          onError(wrappedError)
        }
      })
    inFlight = current
    await current
    if (inFlight === current) {
      inFlight = undefined
    }
    if (dirty) {
      await run()
    }
  }

  function trigger(): void {
    dirty = true
    if (timeout) {
      return
    }
    timeout = setTimeout(() => {
      timeout = undefined
      void run()
    }, waitMs)
  }

  async function flush(): Promise<void> {
    if (timeout) {
      clearTimeout(timeout)
      timeout = undefined
    }
    await run()
  }

  const processFlushCallback: FlushCallback = async () => {
    await flush()
  }
  processFlushCallbacks.add(processFlushCallback)

  async function dispose(): Promise<void> {
    processFlushCallbacks.delete(processFlushCallback)
    await flush()
  }

  return {
    trigger,
    flush,
    dispose,
  }
}
