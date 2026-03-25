// Hrana v2 value encoding/decoding.
//
// SQLite -> Hrana JSON:
//   INTEGER -> {"type":"integer","value":"42"}  (string to avoid precision loss)
//   REAL    -> {"type":"float","value":3.14}
//   TEXT    -> {"type":"text","value":"hello"}
//   BLOB    -> {"type":"blob","base64":"..."}
//   NULL    -> {"type":"null"}

import type { HranaValue, HranaStmt } from './types.ts'

export function encodeHranaValue(val: unknown): HranaValue {
  if (val === null || val === undefined) {
    return { type: 'null' }
  }
  if (typeof val === 'bigint') {
    return { type: 'integer', value: val.toString() }
  }
  if (typeof val === 'number') {
    if (Number.isInteger(val)) {
      return { type: 'integer', value: val.toString() }
    }
    return { type: 'float', value: val }
  }
  if (typeof val === 'string') {
    return { type: 'text', value: val }
  }
  if (val instanceof ArrayBuffer) {
    return { type: 'blob', base64: uint8ArrayToBase64(new Uint8Array(val)) }
  }
  if (val instanceof Uint8Array) {
    return { type: 'blob', base64: uint8ArrayToBase64(val) }
  }
  // Node.js Buffer is a Uint8Array subclass, caught above
  return { type: 'text', value: String(val) }
}

export function decodeHranaValue(val: HranaValue): unknown {
  if (val.type === 'null') {
    return null
  }
  if (val.type === 'integer') {
    const n = Number(val.value)
    return Number.isSafeInteger(n) ? n : BigInt(val.value)
  }
  if (val.type === 'float') {
    return val.value
  }
  if (val.type === 'text') {
    return val.value
  }
  if (val.type === 'blob') {
    return base64ToUint8Array(val.base64)
  }
  return null
}

export function decodeHranaParams(stmt: HranaStmt): unknown[] {
  if (stmt.named_args && stmt.named_args.length > 0) {
    const named: Record<string, unknown> = {}
    for (const na of stmt.named_args) {
      named[na.name] = decodeHranaValue(na.value)
    }
    return [named]
  }
  return (stmt.args ?? []).map(decodeHranaValue)
}

// Runtime-agnostic base64 helpers (no Node.js Buffer dependency)

function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Use btoa which is available in all modern runtimes (Node 16+, Workers, browsers)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
