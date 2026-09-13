/**
 * Discord colored text generator. Wraps input in highlight.js code fences
 * Discord actually colors, then copies markdown you can paste in chat.
 */
'use client'

import { useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'

const DISCORD_MESSAGE_LIMIT = 2000

type ColorOption = {
  id: string
  label: string
  color: string
  background?: string
  language: string
  transform: (text: string) => string
}

function prefixLines(text: string, prefix: string) {
  return text.split('\n').map((line) => prefix + line).join('\n')
}

function wrapLines(text: string, before: string, after: string) {
  return text.split('\n').map((line) => before + line + after).join('\n')
}

function fence(language: string, body: string) {
  return '```' + language + '\n' + body + '\n```'
}

const COLORS: ColorOption[] = [
  {
    id: 'red',
    label: 'Red',
    color: '#dc322f',
    language: 'diff',
    transform: (text) => prefixLines(text, '- '),
  },
  {
    id: 'orange',
    label: 'Orange',
    color: '#cb4b16',
    language: 'css',
    transform: (text) => wrapLines(text, '[', ']'),
  },
  {
    id: 'yellow',
    label: 'Yellow',
    color: '#b58900',
    language: 'fix',
    transform: (text) => text,
  },
  {
    id: 'lime',
    label: 'Lime',
    color: '#859900',
    language: 'diff',
    transform: (text) => prefixLines(text, '+ '),
  },
  {
    id: 'cyan',
    label: 'Cyan',
    color: '#2aa198',
    language: 'yaml',
    transform: (text) => text,
  },
  {
    id: 'blue',
    label: 'Blue',
    color: '#268bd2',
    language: 'ini',
    transform: (text) => wrapLines(text, '[', ']'),
  },
  {
    id: 'light-gray',
    label: 'Gray',
    color: '#93a1a1',
    language: '',
    transform: (text) => text,
  },
  {
    id: 'dark-gray',
    label: 'Dark gray',
    color: '#586e75',
    language: 'yaml',
    transform: (text) => prefixLines(text, '# '),
  },
  {
    id: 'highlight',
    label: 'Highlighted',
    color: '#fdf6e3',
    background: '#073642',
    language: 'tex',
    transform: (text) => prefixLines(text, '$ '),
  },
]

const DEFAULT_TEXT = 'hello, world!'

export function DiscordColoredTextGenerator() {
  const [text, setText] = useState(DEFAULT_TEXT)
  const [colorId, setColorId] = useState('yellow')
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  )

  const color = COLORS.find((item) => item.id === colorId) ?? COLORS[2]
  const body = useMemo(() => color.transform(text), [color, text])
  const markdown = useMemo(
    () => fence(color.language, body),
    [body, color.language],
  )
  const hasTripleBackticks = text.includes('```')
  const tooLong = markdown.length > DISCORD_MESSAGE_LIMIT
  const canCopy = text.length > 0 && !hasTripleBackticks && !tooLong

  async function copyMarkdown() {
    if (!canCopy) return
    try {
      await navigator.clipboard.writeText(markdown)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('failed')
    }
    globalThis.setTimeout(() => {
      setCopyStatus('idle')
    }, 1800)
  }

  return (
    <div className='flex flex-col gap-5'>
      <div className='flex flex-wrap gap-2'>
        {COLORS.map((item) => {
          const selected = item.id === color.id
          return (
            <button
              key={item.id}
              type='button'
              aria-pressed={selected}
              onClick={() => setColorId(item.id)}
              className='rounded-full border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'
              style={{
                color: item.color,
                background: item.background ?? 'transparent',
                borderColor: selected ? item.color : 'var(--border)',
                boxShadow: selected ? `0 0 0 1px ${item.color}` : undefined,
              }}
            >
              {item.label}
            </button>
          )
        })}
      </div>

      <div className='grid gap-4 md:grid-cols-2'>
        <label className='flex flex-col gap-2'>
          <span className='text-sm font-medium text-foreground'>Your text</span>
          <textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              setCopyStatus('idle')
            }}
            rows={8}
            spellCheck={false}
            className='min-h-[180px] resize-y rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary'
            placeholder='Write the Discord message to color'
          />
        </label>

        <div className='flex flex-col gap-2'>
          <span className='text-sm font-medium text-foreground'>
            Approximate Discord preview
          </span>
          <div className='min-h-[180px] rounded-lg border border-border bg-[#313338] px-3 py-3'>
            <div className='mb-2 text-[11px] font-semibold text-[#f2f3f5]'>
              Preview
              <span className='ml-2 rounded bg-[#5865f2] px-1 py-px text-[9px] font-bold uppercase tracking-wide text-white'>
                BOT
              </span>
            </div>
            <pre
              className='overflow-x-auto whitespace-pre-wrap rounded-md px-3 py-2 font-mono text-[13px] leading-5'
              style={{
                color: color.color,
                background: color.background ?? '#2b2d31',
              }}
            >
              {body || ' '}
            </pre>
          </div>
        </div>
      </div>

      <label className='flex flex-col gap-2'>
        <span className='text-sm font-medium text-foreground'>
          Copy this into Discord
        </span>
        <textarea
          value={markdown}
          readOnly
          rows={6}
          spellCheck={false}
          className='min-h-[120px] resize-y rounded-lg border border-border bg-muted px-3 py-2 font-mono text-sm text-foreground outline-none'
        />
      </label>

      <div className='flex flex-wrap items-center gap-3'>
        <button
          type='button'
          disabled={!canCopy}
          onClick={() => {
            void copyMarkdown()
          }}
          className='inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'
        >
          {copyStatus === 'copied' ? <Check size={14} /> : <Copy size={14} />}
          {copyStatus === 'copied' ? 'Copied' : 'Copy markdown'}
        </button>
        <button
          type='button'
          disabled={text.length === 0}
          onClick={() => {
            setText('')
            setCopyStatus('idle')
          }}
          className='rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'
        >
          Clear
        </button>
        <span
          className='text-sm text-muted-foreground'
          aria-live='polite'
        >
          {markdown.length.toLocaleString()} / {DISCORD_MESSAGE_LIMIT.toLocaleString()} characters
        </span>
      </div>

      {hasTripleBackticks && (
        <p className='text-sm text-destructive'>
          Discord code blocks cannot contain triple backticks.
        </p>
      )}
      {tooLong && !hasTripleBackticks && (
        <p className='text-sm text-destructive'>
          This output is over Discord's 2,000 character limit. Shorten the text.
        </p>
      )}
      {copyStatus === 'failed' && (
        <p className='text-sm text-destructive' aria-live='polite'>
          Could not copy. Select the markdown and copy it manually.
        </p>
      )}
    </div>
  )
}
