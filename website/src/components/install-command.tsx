/**
 * Interactive install command button with clipboard copy.
 * Client component because it uses useState for the copy feedback.
 *
 * Source: https://github.com/remorses/termcast/blob/main/website/src/components/install-command.tsx
 */
'use client'

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

export function InstallCommand() {
  const [copied, setCopied] = useState(false)
  const command = 'npx -y kimaki@latest'

  return (
    <button
      className='flex items-center gap-3 mt-7 sm:mt-8 px-5 py-3 bg-secondary border border-border hover:border-foreground/20 transition-colors group cursor-pointer'
      onClick={() => {
        navigator.clipboard.writeText(command)
        setCopied(true)
        globalThis.setTimeout(() => {
          setCopied(false)
        }, 2000)
      }}
    >
      <span className='font-mono text-sm text-foreground/60'>
        <span className='text-primary'>$</span> {command}
      </span>
      {copied ? (
        <Check size={14} className='text-emerald-400' />
      ) : (
        <Copy
          size={14}
          className='text-foreground/30 group-hover:text-foreground/60 transition-colors'
        />
      )}
    </button>
  )
}
