// Reusable debounce helper for timeout-based callbacks.
// Encapsulates the timer handle and exposes trigger/clear/isPending so callers
// can batch clustered events without leaking timeout state into domain logic.

export function createDebouncedTimeout({
  delayMs,
  callback,
}: {
  delayMs: number
  callback: () => void
}): {
  trigger: () => void
  clear: () => void
  isPending: () => boolean
} {
  let timeout: ReturnType<typeof setTimeout> | null = null

  function clear(): void {
    if (!timeout) {
      return
    }
    clearTimeout(timeout)
    timeout = null
  }

  function trigger(): void {
    clear()
    timeout = setTimeout(() => {
      timeout = null
      callback()
    }, delayMs)
  }

  function isPending(): boolean {
    return timeout !== null
  }

  return {
    trigger,
    clear,
    isPending,
  }
}
