// ESM native loader for the usecomputer Zig addon using createRequire.

import os from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export interface NativeModule {
  execute(command: string, payloadJson: string): string
}

function loadCandidate(path: string): NativeModule | null {
  try {
    return require(path) as NativeModule
  } catch {
    return null
  }
}

function loadNativeModule(): NativeModule | null {
  const dev = loadCandidate('../zig-out/lib/usecomputer.node')
  if (dev) {
    return dev
  }

  const platform = os.platform()
  const arch = os.arch()
  const target = `${platform}-${arch}`

  const packaged = loadCandidate(`../dist/${target}/usecomputer.node`)
  if (packaged) {
    return packaged
  }

  return null
}

export const native = loadNativeModule()
