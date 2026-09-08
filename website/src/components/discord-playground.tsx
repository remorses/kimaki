/**
 * Interactive Discord playground for the homepage hero.
 * Scripted Kimaki sessions (voice, queue, permissions, selects, worktrees)
 * with Discord UI. Sizes are em-based so the parent font-size scales the window.
 */
'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'

type PlaygroundPermission = 'accept' | 'always' | 'deny'

type PlaygroundMessage = {
  author: 'user' | 'kimaki'
  time?: string
  text: string
  image?: {
    src: string
    width: number
    height: number
  }
  cta?: boolean
  footer?: string
  voice?: {
    duration: string
  }
  permission?: boolean
  select?: {
    header: string
    question: string
    options: {
      label: string
      description: string
    }[]
  }
  queueAck?: boolean
  reveal?: 'select' | 'permission-accept' | 'permission-deny' | 'queue-kept'
}

type PlaygroundThreadUi = {
  selectAnswer?: string
  permission?: PlaygroundPermission
  queueRemoved?: boolean
  queueDrained?: boolean
}

const DEPLOY_REPLY: PlaygroundMessage = {
  author: 'kimaki',
  time: 'Today at 4:01 PM',
  text: 'To start using Kimaki, deploy your own bot with `npx -y kimaki@latest`.',
  cta: true,
  footer: 'kimaki ⋅ main ⋅ 2s ⋅ 4% ⋅ claude-opus-4-6',
}

const CHANNELS: {
  id: string
  name: string
  threads: {
    id: string
    name: string
    title: string
    summary: string
    messages: PlaygroundMessage[]
  }[]
}[] = [
  {
    id: 'web-app',
    name: 'web-app',
    threads: [
      {
        id: 'voice-login-timeout',
        name: 'midjourney still',
        title: 'Generate a Midjourney still from a voice note',
        summary:
          'Record a voice note. Kimaki transcribes it, then drives Midjourney in the browser.',
        messages: [
          {
            author: 'user',
            time: 'Today at 2:14 PM',
            text: '',
            voice: { duration: '0:08' },
          },
          {
            author: 'kimaki',
            time: 'Today at 2:14 PM',
            text: 'Transcribing voice message...',
          },
          {
            author: 'kimaki',
            time: 'Today at 2:14 PM',
            text: '📝 **Transcribed message:** open midjourney in the browser and generate a still. pale light, almost nothing in it.',
          },
          {
            author: 'kimaki',
            time: 'Today at 2:14 PM',
            text: '┣ bash playwriter open https://www.midjourney.com/imagine',
          },
          {
            author: 'kimaki',
            time: 'Today at 2:15 PM',
            text: 'here.',
            image: {
              src: '/playground/gen-2.jpg',
              width: 800,
              height: 533,
            },
            footer: 'web-app ⋅ main ⋅ 41s ⋅ 14% ⋅ claude-opus-4-6',
          },
        ],
      },
      {
        id: 'queue-commit-after-refactor',
        name: 'queue a commit',
        title: 'Queue a commit after the refactor',
        summary:
          'Line up a follow-up for when the current run finishes. Kimaki commits after the refactor.',
        messages: [
          {
            author: 'user',
            time: 'Today at 3:02 PM',
            text: 'extract formatFooter into cli/src/session-footer.ts',
          },
          {
            author: 'kimaki',
            time: 'Today at 3:02 PM',
            text: '◼︎ write cli/src/session-footer.ts',
          },
          {
            author: 'kimaki',
            time: 'Today at 3:02 PM',
            text: '◼︎ edit cli/src/session-handler/thread-session-runtime.ts',
          },
          {
            author: 'user',
            time: 'Today at 3:03 PM',
            text: 'commit this when you are done. queue',
          },
          {
            author: 'kimaki',
            time: 'Today at 3:03 PM',
            text: 'Queued message (position 1)',
            queueAck: true,
          },
          {
            author: 'kimaki',
            time: 'Today at 3:03 PM',
            text: 'Moved `formatFooter` into `cli/src/session-footer.ts` and pointed the runtime at it.',
            footer: 'web-app ⋅ main ⋅ 48s ⋅ 17% ⋅ claude-opus-4-6',
          },
          {
            author: 'kimaki',
            time: 'Today at 3:03 PM',
            text: '» **Tommy:** commit this when you are done',
            reveal: 'queue-kept',
          },
          {
            author: 'kimaki',
            time: 'Today at 3:03 PM',
            text: '┣ bash git commit',
            reveal: 'queue-kept',
          },
          {
            author: 'kimaki',
            time: 'Today at 3:03 PM',
            text: 'Committed on main: extract formatFooter helper.',
            footer: 'web-app ⋅ main ⋅ 12s ⋅ 19% ⋅ claude-opus-4-6',
            reveal: 'queue-kept',
          },
        ],
      },
    ],
  },
  {
    id: 'api',
    name: 'api',
    threads: [
      {
        id: 'approve-production-migration',
        name: 'prod migration',
        title: 'Approve a production database migration',
        summary:
          'Kimaki asks before a dangerous command. Accept once, always allow, or deny.',
        messages: [
          {
            author: 'user',
            time: 'Today at 11:41 AM',
            text: 'run the production migration',
          },
          {
            author: 'kimaki',
            time: 'Today at 11:41 AM',
            text: '⚠️ **Permission Required**\n**Type:** `bash`\n**Pattern:** `pnpm db:migrate --prod`',
            permission: true,
          },
          {
            author: 'kimaki',
            time: 'Today at 11:41 AM',
            text: '┣ bash pnpm db:migrate --prod',
            reveal: 'permission-accept',
          },
          {
            author: 'kimaki',
            time: 'Today at 11:41 AM',
            text: 'Applied 3 migrations. `users` now has `last_seen_at`.',
            footer: 'api ⋅ main ⋅ 22s ⋅ 8% ⋅ claude-opus-4-6',
            reveal: 'permission-accept',
          },
          {
            author: 'kimaki',
            time: 'Today at 11:41 AM',
            text: 'Skipped the production migrate. Say if you want a dry-run against staging instead.',
            footer: 'api ⋅ main ⋅ 4s ⋅ 6% ⋅ claude-opus-4-6',
            reveal: 'permission-deny',
          },
        ],
      },
    ],
  },
  {
    id: 'docs',
    name: 'docs',
    threads: [
      {
        id: 'pick-docs-rewrite',
        name: 'rewrite getting-started',
        title: 'Pick a rewrite strategy from a dropdown',
        summary:
          'The agent asks with a Discord dropdown. Your pick is posted back as the next message.',
        messages: [
          {
            author: 'user',
            time: 'Today at 4:18 PM',
            text: 'rewrite getting-started so a new user can install in one minute',
          },
          {
            author: 'kimaki',
            time: 'Today at 4:18 PM',
            text: '',
            select: {
              header: 'Tone',
              question: 'Which voice should the page use?',
              options: [
                {
                  label: 'Casual, with code first',
                  description: 'Lead with the install command, then explain',
                },
                {
                  label: 'Formal reference',
                  description: 'Full options, flags, and edge cases',
                },
                {
                  label: 'Short checklist',
                  description: 'Numbered steps only, almost no prose',
                },
              ],
            },
          },
          {
            author: 'kimaki',
            time: 'Today at 4:18 PM',
            text: '» **Tommy:** {select}',
            reveal: 'select',
          },
          {
            author: 'kimaki',
            time: 'Today at 4:18 PM',
            text: '◼︎ write docs/getting-started.mdx',
            reveal: 'select',
          },
          {
            author: 'kimaki',
            time: 'Today at 4:19 PM',
            text: 'Rewrote it around `npx -y kimaki@latest` first, then the Discord install click.',
            footer: 'docs ⋅ main ⋅ 41s ⋅ 15% ⋅ claude-opus-4-6',
            reveal: 'select',
          },
        ],
      },
    ],
  },
  {
    id: 'website',
    name: 'website',
    threads: [
      {
        id: 'landing-hero-still',
        name: 'landing hero still',
        title: 'Generate a still for the landing hero',
        summary:
          'Type a prompt. Kimaki generates the image and shows it inline in the thread.',
        messages: [
          {
            author: 'user',
            time: 'Today at 1:12 PM',
            text: 'generate a still for the landing hero. pale light, almost nothing in it.',
          },
          {
            author: 'kimaki',
            time: 'Today at 1:13 PM',
            text: 'here.',
            image: {
              src: '/playground/gen-1.jpg',
              width: 800,
              height: 448,
            },
            footer: 'website ⋅ main ⋅ 9s ⋅ 6% ⋅ gemini-3-pro',
          },
        ],
      },
      {
        id: 'isolated-dark-mode-worktree',
        name: 'dark-mode worktree',
        title: 'Build dark mode in an isolated worktree',
        summary:
          '/new-worktree moves this session into an isolated folder so main stays clean.',
        messages: [
          {
            author: 'user',
            time: 'Today at 5:08 PM',
            text: '/new-worktree dark-mode',
          },
          {
            author: 'kimaki',
            time: 'Today at 5:08 PM',
            text: 'Created worktree `opencode/kimaki-dark-mode`. This thread now edits an isolated checkout, not main.',
          },
          {
            author: 'user',
            time: 'Today at 5:08 PM',
            text: 'make the hero dark by default',
          },
          {
            author: 'kimaki',
            time: 'Today at 5:08 PM',
            text: '◼︎ edit src/components/hero-section.tsx',
          },
          {
            author: 'kimaki',
            time: 'Today at 5:09 PM',
            text: 'Hero now defaults to dark. The main checkout is untouched. Merge later with `/merge-worktree`.',
            footer: 'website ⋅ opencode/kimaki-dark-mode ⋅ 27s ⋅ 11% ⋅ claude-opus-4-6',
          },
        ],
      },
    ],
  },
]

const DEFAULT_THREAD_ID = 'voice-login-timeout'

function HashIcon() {
  return (
    <svg width='1.25em' height='1.25em' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
      <path
        fill='currentColor'
        fillRule='evenodd'
        d='M10.99 3.16A1 1 0 1 0 9 2.84L8.15 8H4a1 1 0 0 0 0 2h3.82l-.67 4H3a1 1 0 1 0 0 2h3.82l-.8 4.84a1 1 0 0 0 1.97.32L8.85 16h4.97l-.8 4.84a1 1 0 0 0 1.97.32l.86-5.16H20a1 1 0 1 0 0-2h-3.82l.67-4H21a1 1 0 1 0 0-2h-3.82l.8-4.84a1 1 0 1 0-1.97-.32L15.15 8h-4.97l.8-4.84ZM14.15 14H9.18l.67-4h4.97l-.67 4Z'
        clipRule='evenodd'
      />
    </svg>
  )
}

function ThreadIcon({ size = '1em' }: { size?: string }) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' fill='none' aria-hidden='true'>
      <path
        fill='currentColor'
        d='M12 2.81a1 1 0 0 1 0-1.41l.36-.36a1 1 0 0 1 1.41 0l9.2 9.2a1 1 0 0 1 0 1.4l-.7.7a1 1 0 0 1-1.3.13l-9.54-6.72a1 1 0 0 1-.08-1.58l1-1L12 2.8ZM12 21.2a1 1 0 0 1 0 1.41l-.35.35a1 1 0 0 1-1.41 0l-9.2-9.19a1 1 0 0 1 0-1.41l.7-.7a1 1 0 0 1 1.3-.12l9.54 6.72a1 1 0 0 1 .07 1.58l-1 1 .35.36ZM15.66 16.8a1 1 0 0 1-1.38.28l-8.49-5.66A1 1 0 1 1 6.9 9.76l8.49 5.65a1 1 0 0 1 .27 1.39ZM17.1 14.25a1 1 0 1 0 1.11-1.66L9.73 6.93a1 1 0 0 0-1.11 1.66l8.49 5.66Z'
      />
    </svg>
  )
}

function ThreadTree({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <span
      aria-hidden='true'
      className='pointer-events-none absolute left-[1.125em] w-0 border-l-[2px] border-[#4e5058]'
      style={{
        top: '-0.15em',
        height: `calc(${count} * 2em - 0.85em)`,
      }}
    />
  )
}

function ChevronIcon() {
  return (
    <svg width='1em' height='1em' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
      <path
        fill='currentColor'
        d='M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42Z'
      />
    </svg>
  )
}

function InviteIcon() {
  return (
    <svg width='1em' height='1em' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
      <path
        fill='currentColor'
        d='M14.5 8a3 3 0 1 0-3-3 3 3 0 0 0 3 3ZM7 9a2.5 2.5 0 1 0-2.5-2.5A2.5 2.5 0 0 0 7 9Zm7.5 2c-2.42 0-4.66.87-6.2 2.33A5 5 0 0 1 14.5 19H21v-2.5A4.5 4.5 0 0 0 16.5 12h-2ZM3 12.5A3.5 3.5 0 0 1 6.5 9H7a4.5 4.5 0 0 1 3.37 1.5A8.5 8.5 0 0 0 8 19H3v-6.5Z'
      />
      <path
        fill='currentColor'
        d='M21 6h-1V5a1 1 0 1 0-2 0v1h-1a1 1 0 1 0 0 2h1v1a1 1 0 1 0 2 0V8h1a1 1 0 1 0 0-2Z'
      />
    </svg>
  )
}

function PinIcon() {
  return (
    <svg width='1.25em' height='1.25em' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
      <path
        fill='currentColor'
        d='M19.38 11.38a3 3 0 0 0 4.24 0l.03-.03a.5.5 0 0 0 0-.7L13.35.35a.5.5 0 0 0-.7 0l-.03.03a3 3 0 0 0 0 4.24L13 5l-2.92 2.92-3.65-.34a2 2 0 0 0-1.6.58l-.62.63a1 1 0 0 0 0 1.42l9.58 9.58a1 1 0 0 0 1.42 0l.63-.63a2 2 0 0 0 .58-1.6l-.34-3.64L19 11l.38.38ZM9.07 17.07a.5.5 0 0 1-.08.77l-5.15 3.43a.5.5 0 0 1-.63-.06l-.42-.42a.5.5 0 0 1-.06-.63L6.16 15a.5.5 0 0 1 .77-.08l2.14 2.15Z'
      />
    </svg>
  )
}

function MembersIcon() {
  return (
    <svg width='1.25em' height='1.25em' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
      <path
        fill='currentColor'
        d='M14.5 8a3 3 0 1 0-3-3 3 3 0 0 0 3 3ZM7 9a2.5 2.5 0 1 0-2.5-2.5A2.5 2.5 0 0 0 7 9Zm7.5 3c-3.05 0-5.5 2.2-5.5 5v2h14v-2c0-2.8-2.45-5-5.5-5ZM6.5 14c-.54 0-1.05.08-1.54.24A4.9 4.9 0 0 0 3 19v2h3v-2c0-1.77.7-3.37 1.84-4.55A6.3 6.3 0 0 0 6.5 14Z'
      />
    </svg>
  )
}

function BellIcon() {
  return (
    <svg width='1.25em' height='1.25em' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
      <path
        fill='currentColor'
        d='M9.2 21.05a2.99 2.99 0 0 0 5.6 0H9.2ZM12 2a1 1 0 0 1 1 1v.18A7 7 0 0 1 19 10v5.76l1.7 2.55A1 1 0 0 1 19.87 20H4.13a1 1 0 0 1-.83-1.69L5 15.76V10a7 7 0 0 1 6-6.82V3a1 1 0 0 1 1-1Z'
      />
    </svg>
  )
}

function PlusCircleIcon() {
  return (
    <svg width='1.5em' height='1.5em' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
      <circle cx='12' cy='12' r='11' fill='currentColor' />
      <path
        d='M12 7v10M7 12h10'
        stroke='#313338'
        strokeWidth='2.2'
        strokeLinecap='round'
      />
    </svg>
  )
}

function GiftIcon() {
  return (
    <svg width='1.25em' height='1.25em' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
      <path
        fill='currentColor'
        d='M9.5 4A2.5 2.5 0 0 0 7 6.5V7H3a1 1 0 0 0-1 1v3h10V8H9.5V6.5A1.5 1.5 0 0 1 11 5h.5A2.5 2.5 0 0 0 9.5 4Zm5 0A2.5 2.5 0 0 0 12.5 5H13a1.5 1.5 0 0 1 1.5 1.5V8H12v3h10V8a1 1 0 0 0-1-1h-4v-.5A2.5 2.5 0 0 0 14.5 4ZM2 13v7a2 2 0 0 0 2 2h7v-9H2Zm11 9h7a2 2 0 0 0 2-2v-7h-9v9Z'
      />
    </svg>
  )
}

function GifIcon() {
  return (
    <svg width='1.25em' height='1.25em' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
      <path
        fill='currentColor'
        fillRule='evenodd'
        d='M5 4a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3H5Zm2.5 5.5H9V11H7.5v2H9v1.5H7.25A1.75 1.75 0 0 1 5.5 12.75v-1.5A1.75 1.75 0 0 1 7.25 9.5h.25Zm4 0H13v5h-1.5v-5Zm3 0H19V11h-2.5v1H18v1.5h-1.5V16H15v-6.5Z'
        clipRule='evenodd'
      />
    </svg>
  )
}

function EmojiIcon() {
  return (
    <svg width='1.25em' height='1.25em' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
      <path
        fill='currentColor'
        fillRule='evenodd'
        d='M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22ZM6.5 12.5a1 1 0 0 1 1 1c0 2.3 2.02 4 4.5 4s4.5-1.7 4.5-4a1 1 0 1 1 2 0c0 3.4-2.92 6-6.5 6s-6.5-2.6-6.5-6a1 1 0 0 1 1-1ZM10 10a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm7 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z'
        clipRule='evenodd'
      />
    </svg>
  )
}

function StickerIcon() {
  return (
    <svg width='1.25em' height='1.25em' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
      <path
        fill='currentColor'
        d='M5 2a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h8.5a1 1 0 0 0 .7-.3l7.5-7.5a1 1 0 0 0 .3-.7V5a3 3 0 0 0-3-3H5Zm13.6 11L13 18.6V15a2 2 0 0 1 2-2h3.6Z'
      />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width='1.125em' height='1.125em' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
      <path
        fill='currentColor'
        d='M12 2a4 4 0 0 0-4 4v5a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4ZM6 11a1 1 0 1 0-2 0 8 8 0 0 0 7 7.94V21H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.06A8 8 0 0 0 20 11a1 1 0 1 0-2 0 6 6 0 0 1-12 0Z'
      />
    </svg>
  )
}

function HeadphonesIcon() {
  return (
    <svg width='1.125em' height='1.125em' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
      <path
        fill='currentColor'
        d='M12 3a9 9 0 0 0-9 9v5a3 3 0 0 0 3 3h1a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H5.08A7 7 0 0 1 12 5a7 7 0 0 1 6.92 6H17a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1a3 3 0 0 0 3-3v-5a9 9 0 0 0-9-9Z'
      />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width='1.125em' height='1.125em' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
      <path
        fill='currentColor'
        fillRule='evenodd'
        d='M10.65 3.06a2 2 0 0 1 2.7 0l.4.4a2 2 0 0 0 2.12.44l.53-.2a2 2 0 0 1 2.53 1.05l.7 1.4a2 2 0 0 0 1.47 1.08l.56.08a2 2 0 0 1 1.74 2.2l-.08.56a2 2 0 0 0 .44 1.68l.4.4a2 2 0 0 1 0 2.7l-.4.4a2 2 0 0 0-.44 2.12l.2.53a2 2 0 0 1-1.05 2.53l-1.4.7a2 2 0 0 0-1.08 1.47l-.08.56a2 2 0 0 1-2.2 1.74l-.56-.08a2 2 0 0 0-1.68.44l-.4.4a2 2 0 0 1-2.7 0l-.4-.4a2 2 0 0 0-2.12-.44l-.53.2a2 2 0 0 1-2.53-1.05l-.7-1.4a2 2 0 0 0-1.47-1.08l-.56-.08a2 2 0 0 1-1.74-2.2l.08-.56a2 2 0 0 0-.44-1.68l-.4-.4a2 2 0 0 1 0-2.7l.4-.4a2 2 0 0 0 .44-2.12l-.2-.53a2 2 0 0 1 1.05-2.53l1.4-.7a2 2 0 0 0 1.08-1.47l.08-.56a2 2 0 0 1 2.2-1.74l.56.08a2 2 0 0 0 1.68-.44l.4-.4ZM12 15.5A3.5 3.5 0 1 0 12 8.5a3.5 3.5 0 0 0 0 7Z'
        clipRule='evenodd'
      />
    </svg>
  )
}

function ClydeIcon() {
  return (
    <svg width='1.75em' height='1.25em' viewBox='0 0 36 24' fill='none' aria-hidden='true'>
      <path
        fill='currentColor'
        d='M30.16 1.6A29.2 29.2 0 0 0 22.98.13a.11.11 0 0 0-.12.05 20.3 20.3 0 0 0-.9 1.84 26.9 26.9 0 0 0-8.07 0A18.6 18.6 0 0 0 13 .18a.11.11 0 0 0-.12-.05 29.1 29.1 0 0 0-7.18 1.47A30.3 30.3 0 0 0 .16 19.3a.11.11 0 0 0 .04.08 29.4 29.4 0 0 0 8.87 4.49.11.11 0 0 0 .13-.04c.68-.93 1.3-1.92 1.82-2.95a.11.11 0 0 0-.06-.15 19.4 19.4 0 0 1-2.76-1.32.11.11 0 0 1-.01-.18c.19-.14.37-.29.55-.44a.11.11 0 0 1 .11-.02c5.8 2.65 12.08 2.65 17.81 0a.11.11 0 0 1 .12.02c.18.15.36.3.55.44a.11.11 0 0 1 0 .18 18.2 18.2 0 0 1-2.76 1.32.11.11 0 0 0-.06.15 26.3 26.3 0 0 0 1.82 2.95.11.11 0 0 0 .13.04 29.3 29.3 0 0 0 8.88-4.49.11.11 0 0 0 .04-.08 30.1 30.1 0 0 0-5.16-17.7ZM12.03 15.9c-1.74 0-3.18-1.6-3.18-3.56s1.41-3.56 3.18-3.56 3.21 1.61 3.18 3.56c0 1.96-1.41 3.56-3.18 3.56Zm12.02 0c-1.74 0-3.18-1.6-3.18-3.56s1.41-3.56 3.18-3.56 3.21 1.61 3.18 3.56c0 1.96-1.41 3.56-3.18 3.56Z'
      />
    </svg>
  )
}

function findThread(threadId: string) {
  for (const channel of CHANNELS) {
    const thread = channel.threads.find((item) => item.id === threadId)
    if (thread) return { channel, thread }
  }
  const channel = CHANNELS[0]
  return { channel, thread: channel.threads[0] }
}

function isMessageVisible(
  message: PlaygroundMessage,
  ui: PlaygroundThreadUi,
): boolean {
  if (!message.reveal) return true
  if (message.reveal === 'select') return Boolean(ui.selectAnswer)
  if (message.reveal === 'permission-accept') {
    return ui.permission === 'accept' || ui.permission === 'always'
  }
  if (message.reveal === 'permission-deny') return ui.permission === 'deny'
  if (message.reveal === 'queue-kept') {
    return Boolean(ui.queueDrained) && !ui.queueRemoved
  }
  return true
}

function DiscordText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g)
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <strong key={index} className='font-semibold text-[#f2f3f5]'>
              {part.slice(2, -2)}
            </strong>
          )
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code
              key={index}
              className='rounded-[0.25em] bg-[#2b2d31] px-[0.25em] py-[0.05em] font-mono text-[0.9em] text-[#dbdee1]'
            >
              {part.slice(1, -1)}
            </code>
          )
        }
        if (part.startsWith('_') && part.endsWith('_')) {
          return (
            <em key={index} className='italic text-[#b5bac1]'>
              {part.slice(1, -1)}
            </em>
          )
        }
        return <span key={index}>{part}</span>
      })}
    </>
  )
}

function UserAvatar() {
  return (
    <div className='relative size-[2.5em] shrink-0 rounded-full bg-[#5865f2] text-[0.9375em] font-medium leading-[2.5em] text-white text-center select-none'>
      T
    </div>
  )
}

function KimakiAvatar() {
  return (
    <img
      src='/logo.jpeg'
      alt=''
      className='size-[2.5em] shrink-0 rounded-full object-cover'
    />
  )
}

function DiscordButton() {
  return (
    <a
      href='https://github.com/remorses/kimaki'
      target='_blank'
      rel='noopener noreferrer'
      className='mt-[0.5em] inline-flex h-[2em] items-center rounded-[0.25em] bg-[#5865f2] px-[1em] text-[0.875em] font-medium text-white no-underline hover:bg-[#4752c4] active:scale-[0.97]'
    >
      Deploy Kimaki
    </a>
  )
}

function PlayIcon() {
  return (
    <svg width='1.1em' height='1.1em' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
      <path fill='currentColor' d='M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14Z' />
    </svg>
  )
}

function VoiceMessage({ duration }: { duration: string }) {
  const bars = [4, 9, 6, 12, 8, 14, 7, 11, 5, 13, 8, 10, 6, 12, 7, 9, 5, 11, 8, 6]
  return (
    <div className='mt-[0.2em] flex w-[16em] items-center gap-[0.6em] rounded-[1.25em] bg-[#2b2d31] px-[0.7em] py-[0.45em]'>
      <span className='flex size-[1.75em] shrink-0 items-center justify-center rounded-full bg-[#23a559] text-white'>
        <PlayIcon />
      </span>
      <span className='flex min-w-0 flex-1 items-end gap-[0.12em] h-[1.15em]'>
        {bars.map((height, index) => (
          <span
            key={index}
            className='w-[0.18em] rounded-full bg-[#23a559]'
            style={{ height: `${height * 0.08}em` }}
          />
        ))}
      </span>
      <span className='shrink-0 text-[0.75em] font-medium text-[#b5bac1]'>
        {duration}
      </span>
    </div>
  )
}

function PermissionButtons({
  status,
  onChoose,
}: {
  status?: PlaygroundPermission
  onChoose: (status: PlaygroundPermission) => void
}) {
  if (status) return null

  return (
    <div className='mt-[0.45em] flex flex-wrap gap-[0.5em]'>
      <button
        type='button'
        onClick={() => onChoose('accept')}
        className='h-[2em] rounded-[0.25em] bg-[#248046] px-[1em] text-[0.875em] font-medium text-white hover:bg-[#1a6334] active:scale-[0.97]'
      >
        Accept
      </button>
      <button
        type='button'
        onClick={() => onChoose('always')}
        className='h-[2em] rounded-[0.25em] bg-[#248046] px-[1em] text-[0.875em] font-medium text-white hover:bg-[#1a6334] active:scale-[0.97]'
      >
        Accept Always
      </button>
      <button
        type='button'
        onClick={() => onChoose('deny')}
        className='h-[2em] rounded-[0.25em] bg-[#4e5058] px-[1em] text-[0.875em] font-medium text-white hover:bg-[#6d6f78] active:scale-[0.97]'
      >
        Deny
      </button>
    </div>
  )
}

function SelectMenu({
  select,
  answer,
  onSelect,
}: {
  select: NonNullable<PlaygroundMessage['select']>
  answer?: string
  onSelect: (label: string) => void
}) {
  const [open, setOpen] = useState(false)

  if (answer) return null

  return (
    <div className='relative mt-[0.45em] w-[18em] max-w-full'>
      <button
        type='button'
        onClick={() => setOpen((current) => !current)}
        className='flex h-[2.5em] w-full items-center justify-between rounded-[0.25em] bg-[#2b2d31] px-[0.75em] text-left text-[0.875em] text-[#dbdee1] ring-1 ring-[#1e1f22] hover:bg-[#313338]'
      >
        <span className='truncate'>{select.options[0]?.label}</span>
        <span className='ml-[0.5em] shrink-0 text-[#b5bac1]'>
          <ChevronIcon />
        </span>
      </button>
      {open && (
        <div className='absolute top-[2.7em] left-0 z-10 w-full overflow-hidden rounded-[0.25em] bg-[#2b2d31] py-[0.25em] shadow-[0_0.5em_1.5em_rgba(0,0,0,0.45)] ring-1 ring-[#1e1f22]'>
          {select.options.map((option) => (
            <button
              key={option.label}
              type='button'
              onClick={() => {
                onSelect(option.label)
                setOpen(false)
              }}
              className='flex w-full flex-col items-start px-[0.75em] py-[0.45em] text-left hover:bg-[#5865f2]'
            >
              <span className='text-[0.875em] font-medium text-[#f2f3f5]'>
                {option.label}
              </span>
              <span className='text-[0.75em] text-[#b5bac1]'>
                {option.description}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function QueueRemoveButton({
  hidden,
  onRemove,
}: {
  hidden: boolean
  onRemove: () => void
}) {
  if (hidden) return null

  return (
    <button
      type='button'
      onClick={onRemove}
      className='mt-[0.45em] h-[2em] rounded-[0.25em] bg-[#4e5058] px-[1em] text-[0.875em] font-medium text-white hover:bg-[#6d6f78] active:scale-[0.97]'
    >
      Remove from queue
    </button>
  )
}

function TypingDots() {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => {
      setFrame((current) => (current + 1) % 3)
    }, 480)
    return () => window.clearInterval(id)
  }, [])

  return (
    <span className='mr-[0.4em] inline-flex items-center gap-[0.18em]'>
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className='size-[0.4em] rounded-full bg-[#b5bac1]'
          style={{
            backgroundColor: frame === index ? '#dbdee1' : '#4e5058',
            transform: frame === index ? 'scale(1.15)' : 'scale(0.85)',
            transition: 'background-color 240ms ease-out, transform 240ms ease-out',
          }}
        />
      ))}
    </span>
  )
}

export function DiscordPlayground() {
  const [selectedThreadId, setSelectedThreadId] = useState(DEFAULT_THREAD_ID)
  const [draft, setDraft] = useState('')
  const [liveMessages, setLiveMessages] = useState<
    Record<string, PlaygroundMessage[]>
  >({})
  const [threadUi, setThreadUi] = useState<Record<string, PlaygroundThreadUi>>(
    {},
  )
  const { channel, thread } = findThread(selectedThreadId)
  const ui = threadUi[selectedThreadId] ?? {}
  const messages = [...thread.messages, ...(liveMessages[selectedThreadId] ?? [])]
    .filter((message) => isMessageVisible(message, ui))
  const lastMessage = messages[messages.length - 1]
  const waitingOnUser =
    messages.some((message) => message.permission && !ui.permission) ||
    messages.some((message) => message.select && !ui.selectAnswer)
  const drainingQueue =
    selectedThreadId === 'queue-commit-after-refactor' &&
    !ui.queueRemoved &&
    !ui.queueDrained
  const showTyping = drainingQueue || (!waitingOnUser && !lastMessage?.footer)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [selectedThreadId, messages.length])

  useEffect(() => {
    if (selectedThreadId !== 'queue-commit-after-refactor') return
    if (ui.queueRemoved || ui.queueDrained) return
    const id = window.setTimeout(() => {
      setThreadUi((current) => {
        const existing = current[selectedThreadId]
        if (existing?.queueRemoved || existing?.queueDrained) return current
        return {
          ...current,
          [selectedThreadId]: { ...existing, queueDrained: true },
        }
      })
    }, 1600)
    return () => window.clearTimeout(id)
  }, [selectedThreadId, ui.queueRemoved, ui.queueDrained])

  function patchThreadUi(patch: PlaygroundThreadUi) {
    setThreadUi((current) => ({
      ...current,
      [selectedThreadId]: {
        ...current[selectedThreadId],
        ...patch,
      },
    }))
  }

  function sendDraft(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    const userMessage: PlaygroundMessage = {
      author: 'user',
      time: 'Today at 4:01 PM',
      text,
    }
    setLiveMessages((current) => ({
      ...current,
      [selectedThreadId]: [
        ...(current[selectedThreadId] ?? []),
        userMessage,
        DEPLOY_REPLY,
      ],
    }))
    setDraft('')
  }

  return (
    <div
      data-discord-playground
      className='relative flex w-full flex-col overflow-hidden rounded-[0.85em] bg-[#1e1f22] font-normal text-[#dbdee1] shadow-[0_1.5em_5em_rgba(0,0,0,0.45)] ring-1 ring-white/10 pointer-events-none lg:pointer-events-auto'
      style={{
        fontFamily:
          'Inter, "Inter Variable", system-ui, -apple-system, "Segoe UI", sans-serif',
        fontWeight: 400,
        fontSynthesis: 'none',
        fontSize: 'clamp(11px, 1.35cqw, 13px)',
        containerType: 'inline-size',
        aspectRatio: '1.5 / 1',
        minHeight: '32em',
      }}
    >
      <div className='flex h-[2.25em] shrink-0 items-center bg-[#1e1f22] pl-[0.875em]'>
        <div className='flex items-center gap-[0.5em]'>
          <span className='size-[0.75em] rounded-full bg-[#ff5f57]' />
          <span className='size-[0.75em] rounded-full bg-[#febc2e]' />
          <span className='size-[0.75em] rounded-full bg-[#28c840]' />
        </div>
      </div>

      <div className='flex min-h-0 flex-1'>
        <div className='flex w-[4.5em] shrink-0 flex-col items-center bg-[#1e1f22] pt-[0.25em] pb-[0.5em]'>
          <div className='flex size-[3em] items-center justify-center rounded-[1em] bg-[#313338] text-[#dbdee1]'>
            <ClydeIcon />
          </div>
          <div className='my-[0.5em] h-[0.125em] w-[2em] rounded-full bg-[#35363c]' />
          <div className='relative flex w-full justify-center'>
            <span className='absolute top-1/2 left-[0.25em] h-[2em] w-[0.25em] -translate-y-1/2 rounded-full bg-white' />
            <img
              src='/logo.jpeg'
              alt='Kimaki'
              className='size-[3em] rounded-[1em] object-cover'
            />
          </div>
        </div>

        <div className='flex w-[13.5em] shrink-0 flex-col bg-[#2b2d31]'>
          <div className='flex h-[3em] shrink-0 items-center justify-between px-[1em] shadow-[0_0.0625em_0_rgba(0,0,0,0.2)]'>
            <div className='flex min-w-0 items-center gap-[0.25em] text-[1em] font-medium text-white'>
              <span className='truncate'>Kimaki</span>
              <span className='text-[#b5bac1]'>
                <ChevronIcon />
              </span>
            </div>
            <span className='text-[#b5bac1]'>
              <InviteIcon />
            </span>
          </div>

          <div className='min-h-0 flex-1 overflow-y-auto px-[0.5em] pt-[0.75em]'>
            <div className='mb-[0.25em] flex h-[1.5em] items-center gap-[0.125em] px-[0.25em] text-[0.6875em] font-medium tracking-[0.02em] text-[#949ba4] uppercase'>
              <span className='-ml-[0.125em] text-[#949ba4]'>
                <ChevronIcon />
              </span>
              Projects
            </div>
            {CHANNELS.map((item) => {
              const isChannelActive = item.id === channel.id
              return (
                <div key={item.id}>
                  <button
                    type='button'
                    onClick={() => setSelectedThreadId(item.threads[0].id)}
                    className={[
                      'flex h-[2em] w-full items-center gap-[0.375em] rounded-[0.25em] px-[0.5em] text-left text-[1em] leading-[1.25em]',
                      isChannelActive
                        ? 'text-[#f2f3f5]'
                        : 'text-[#949ba4] hover:bg-[#35373c] hover:text-[#dbdee1]',
                    ].join(' ')}
                  >
                    <span className='shrink-0 text-[#80848e]'>
                      <HashIcon />
                    </span>
                    <span className='truncate'>{item.name}</span>
                  </button>
                  <div className='relative'>
                    <ThreadTree count={item.threads.length} />
                    {item.threads.map((itemThread) => {
                      const selected = itemThread.id === selectedThreadId
                      return (
                        <div
                          key={itemThread.id}
                          className='flex h-[2em] items-stretch pl-[1.125em]'
                        >
                          <span
                            aria-hidden='true'
                            className='mt-[1em] h-0 w-[0.7em] shrink-0 border-t-[2px] border-[#4e5058]'
                          />
                          <button
                            type='button'
                            onClick={() => setSelectedThreadId(itemThread.id)}
                            className={[
                              'flex min-w-0 flex-1 items-center rounded-[0.25em] pr-[0.5em] pl-[0.35em] text-left text-[1em] leading-[1.25em]',
                              selected
                                ? 'bg-[#404249] text-white'
                                : 'text-[#949ba4] hover:bg-[#35373c] hover:text-[#dbdee1]',
                            ].join(' ')}
                          >
                            <span className='truncate'>{itemThread.name}</span>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>

          <div className='flex h-[3.25em] shrink-0 items-center gap-[0.5em] bg-[#232428] px-[0.5em]'>
            <div className='relative shrink-0'>
              <div className='size-[2em] rounded-full bg-[#5865f2] text-[0.8125em] font-medium leading-[2em] text-white text-center'>
                T
              </div>
              <span className='absolute right-[-0.0625em] bottom-[-0.0625em] size-[0.625em] rounded-full border-[0.125em] border-[#232428] bg-[#23a559]' />
            </div>
            <div className='min-w-0 flex-1 leading-tight'>
              <div className='truncate text-[0.875em] font-medium text-white'>
                Tommy
              </div>
              <div className='text-[0.75em] text-[#949ba4]'>Online</div>
            </div>
            <div className='flex items-center text-[#b5bac1]'>
              <span className='rounded-[0.25em] p-[0.25em] hover:bg-[#35373c]'>
                <MicIcon />
              </span>
              <span className='rounded-[0.25em] p-[0.25em] hover:bg-[#35373c]'>
                <HeadphonesIcon />
              </span>
              <span className='rounded-[0.25em] p-[0.25em] hover:bg-[#35373c]'>
                <GearIcon />
              </span>
            </div>
          </div>
        </div>

        <div className='flex min-w-0 flex-1 flex-col bg-[#313338]'>
          <div className='flex h-[3em] shrink-0 items-center justify-between gap-[0.75em] px-[1em] shadow-[0_0.0625em_0_rgba(4,4,5,0.2)]'>
            <div className='flex min-w-0 items-center gap-[0.5em] text-[1em] font-medium text-[#f2f3f5]'>
              <span className='shrink-0 text-[#80848e]'>
                <HashIcon />
              </span>
              <span className='truncate'>{channel.name}</span>
              <span className='shrink-0 text-[#4e5058]'>›</span>
              <span className='shrink-0 text-[#80848e]'>
                <ThreadIcon size='1.125em' />
              </span>
              <span className='truncate'>{thread.title}</span>
            </div>
            <div className='hidden shrink-0 items-center gap-[0.75em] text-[#b5bac1] min-[900px]:flex'>
              <BellIcon />
              <PinIcon />
              <MembersIcon />
            </div>
          </div>

          <div className='min-h-0 flex-1 overflow-y-auto pt-[1em]'>
            <div className='px-[1em] pb-[1em]'>
              <div className='mb-[0.5em] flex size-[4em] items-center justify-center rounded-[1em] bg-[#41434a] text-[#dbdee1]'>
                <ThreadIcon size='2.25em' />
              </div>
              <div className='text-[2em] font-medium leading-[1.25] text-white'>
                {thread.title}
              </div>
              <p className='mt-[0.25em] text-[0.875em] leading-[1.375em] text-[#b5bac1]'>
                {thread.summary}
              </p>
            </div>
            {messages.map((message, index) => {
              const prev = messages[index - 1]
              const grouped = Boolean(prev && prev.author === message.author)
              const bodyText = (() => {
                if (message.select) {
                  if (!ui.selectAnswer) {
                    return `**${message.select.header}**\n${message.select.question}`
                  }
                  return `**${message.select.header}**\n${message.select.question}\n✓ _${ui.selectAnswer}_`
                }
                if (message.permission && ui.permission) {
                  const statusLine =
                    ui.permission === 'always'
                      ? '✓ Accepted always'
                      : ui.permission === 'deny'
                        ? '✗ Denied'
                        : '✓ Accepted'
                  return `${message.text}\n${statusLine}`
                }
                if (message.queueAck && ui.queueRemoved) {
                  return 'Removed queued message'
                }
                if (message.reveal === 'select' && ui.selectAnswer) {
                  return message.text.replace('{select}', ui.selectAnswer)
                }
                return message.text
              })()
              return (
                <div
                  key={`${message.author}-${index}`}
                  className={[
                    'flex shrink-0 gap-[1em] px-[1em] pr-[1.5em] hover:bg-[#2e3035]',
                    grouped ? 'py-[0.125em]' : 'mt-[1.05em] py-[0.125em]',
                  ].join(' ')}
                >
                  {grouped ? (
                    <div className='w-[2.5em] shrink-0' />
                  ) : message.author === 'user' ? (
                    <UserAvatar />
                  ) : (
                    <KimakiAvatar />
                  )}
                  <div className='min-w-0'>
                    {!grouped && (
                      <div className='flex items-baseline gap-[0.375em]'>
                        <span className='text-[1em] font-medium leading-[1.375em] text-white'>
                          {message.author === 'user' ? 'Tommy' : 'Kimaki'}
                        </span>
                        {message.author === 'kimaki' && (
                          <span className='relative top-[-0.0625em] rounded-[0.1875em] bg-[#5865f2] px-[0.25em] text-[0.625em] font-medium leading-[0.9375em] text-white'>
                            APP
                          </span>
                        )}
                        {message.time && (
                          <span className='text-[0.75em] leading-[1.375em] text-[#949ba4]'>
                            {message.time}
                          </span>
                        )}
                      </div>
                    )}
                    {message.voice && (
                      <VoiceMessage duration={message.voice.duration} />
                    )}
                    {bodyText && (
                      <div className='whitespace-pre-wrap text-[1em] leading-[1.375em] text-[#dbdee1]'>
                        <DiscordText text={bodyText} />
                      </div>
                    )}
                    {message.image && (
                      <img
                        src={message.image.src}
                        alt=''
                        width={message.image.width}
                        height={message.image.height}
                        className='mt-[0.35em] block max-w-full rounded-[0.5em] object-cover'
                        style={{
                          width: '22em',
                          height: `${(22 * message.image.height) / message.image.width}em`,
                          flexShrink: 0,
                        }}
                      />
                    )}
                    {message.permission && (
                      <PermissionButtons
                        status={ui.permission}
                        onChoose={(status) => patchThreadUi({ permission: status })}
                      />
                    )}
                    {message.select && (
                      <SelectMenu
                        select={message.select}
                        answer={ui.selectAnswer}
                        onSelect={(label) => patchThreadUi({ selectAnswer: label })}
                      />
                    )}
                    {message.queueAck && (
                      <QueueRemoveButton
                        hidden={Boolean(ui.queueRemoved || ui.queueDrained)}
                        onRemove={() => patchThreadUi({ queueRemoved: true })}
                      />
                    )}
                    {message.cta && <DiscordButton />}
                    {message.footer && (
                      <div className='mt-[0.15em] whitespace-pre-wrap text-[0.875em] italic leading-[1.375em] text-[#b5bac1]'>
                        {message.footer}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
            <div ref={messagesEndRef} />
          </div>

          <div className='shrink-0 px-[1em] pb-[1.5em] pt-[0.25em]'>
            {showTyping ? (
              <div className='mb-[0.4em] flex h-[1.5em] items-center pl-[0.15em] text-[0.875em] leading-none'>
                <TypingDots />
                <span className='text-[#dbdee1]'>
                  <span className='font-medium'>Kimaki</span>
                  <span className='text-[#949ba4]'> is typing...</span>
                </span>
              </div>
            ) : (
              <div className='mb-[0.4em] h-[1.5em]' />
            )}
            <form
              onSubmit={sendDraft}
              className='flex h-[2.75em] items-center gap-[0.75em] rounded-[0.5em] bg-[#383a40] px-[0.75em]'
            >
              <span className='text-[#b5bac1]'>
                <PlusCircleIcon />
              </span>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={`Message ${thread.title}`}
                className='min-w-0 flex-1 bg-transparent text-[1em] text-[#dbdee1] outline-none placeholder:text-[#6d6f78]'
              />
              <span className='flex items-center gap-[0.75em] text-[#b5bac1]'>
                <GiftIcon />
                <GifIcon />
                <StickerIcon />
                <EmojiIcon />
              </span>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
