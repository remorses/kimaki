// Minimal type declarations for undici (transitive dep from discord.js).
// We don't list undici in package.json — discord.js bundles it.
declare module 'undici' {
  export class Agent {
    constructor(opts?: {
      headersTimeout?: number
      bodyTimeout?: number
      connections?: number
    })
  }
  export function setGlobalDispatcher(dispatcher: Agent): void
}
