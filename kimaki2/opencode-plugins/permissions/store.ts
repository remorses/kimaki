export type PendingPermission = {
  requestID: string
  sessionID: string
  directory: string
  action: string
  resources: string[]
  message?: string
  hash: string
  messageId?: string
  threadId: string
}

type Store = {
  byHash: Map<string, PendingPermission>
}

declare global {
  var __kimaki2Permissions: Store | undefined
}

function store() {
  globalThis.__kimaki2Permissions ??= { byHash: new Map() }
  return globalThis.__kimaki2Permissions
}

export function savePending(pending: PendingPermission) {
  store().byHash.set(pending.hash, pending)
}

export function takePending(hash: string) {
  const pending = store().byHash.get(hash)
  if (!pending) return null
  store().byHash.delete(hash)
  return pending
}

export function getPending(hash: string) {
  return store().byHash.get(hash) ?? null
}

export function findPendingByRequestID(requestID: string) {
  for (const pending of store().byHash.values()) {
    if (pending.requestID === requestID) return pending
  }
  return null
}

export function removePendingForDirectory(directory: string) {
  for (const [hash, pending] of store().byHash) {
    if (pending.directory !== directory) continue
    store().byHash.delete(hash)
  }
}

export function resetPermissions() {
  globalThis.__kimaki2Permissions = undefined
}
