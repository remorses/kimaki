// Test reset for process singletons owned by plugins.

export function resetKimakiRuntime() {
  const discord = globalThis.__kimaki2Discord
  discord?.stop()
  globalThis.__kimaki2Discord = undefined
  globalThis.__kimaki2DiscordStarting = undefined
  globalThis.__kimaki2Threads = undefined
}
