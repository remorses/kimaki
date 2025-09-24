export function createLogger(prefix: string) {
  return {
    log: (...args: any[]) => console.log(`[${prefix}]`, ...args),
    error: (...args: any[]) => console.error(`[${prefix}]`, ...args),
    warn: (...args: any[]) => console.warn(`[${prefix}]`, ...args),
    info: (...args: any[]) => console.info(`[${prefix}]`, ...args),
    debug: (...args: any[]) => console.debug(`[${prefix}]`, ...args),
  }
}
