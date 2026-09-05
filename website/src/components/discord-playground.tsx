/**
 * Interactive Discord playground for the homepage hero.
 * Sizes are em-based so the parent font-size scales the whole window.
 */
'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'

type PlaygroundMessage = {
  author: 'user' | 'kimaki' | 'system'
  time?: string
  text: string
  image?: {
    src: string
    width: number
    height: number
  }
  cta?: boolean
}

const DEPLOY_REPLY: PlaygroundMessage = {
  author: 'kimaki',
  time: 'Today at 4:01 PM',
  text: 'to start using kimaki deploy your own kimaki',
  cta: true,
}

const CHANNELS: {
  id: string
  name: string
  threads: {
    id: string
    name: string
    messages: PlaygroundMessage[]
  }[]
}[] = [
  {
    id: 'chief',
    name: 'chief',
    threads: [
      {
        id: 'book-the-venue',
        name: 'book the venue',
        messages: [
          {
            author: 'system',
            text: 'Created routine · Morning briefing',
          },
          {
            author: 'kimaki',
            time: 'Yesterday at 3:59 PM',
            text: 'morning briefing:\n✓ Calendar → 2pm double-booking resolved · board review kept\n✓ Deck → numbers checked against finance\'s sheet · 2 stale slides flagged\n✓ Offsite → 3 venues shortlisted · dates held on each\n\ntwo things need you today: the deck review at 2pm, and a yes/no on the venue. everything else is handled.',
          },
          {
            author: 'user',
            time: 'Yesterday at 6:59 PM',
            text: "take the venue, i'll do the deck",
          },
          {
            author: 'kimaki',
            time: 'Yesterday at 6:59 PM',
            text: "the marina house is the pick: seats all 40, the mid-week rate came in 15% under budget, and they'll hold the date until tomorrow.",
          },
          {
            author: 'user',
            time: 'Yesterday at 7:59 PM',
            text: 'book it',
          },
          {
            author: 'kimaki',
            time: 'Yesterday at 7:59 PM',
            text: '✓ Venue → marina house booked · deposit paid\n✓ Calendar → invites updated for all 40\n✓ Holds → other two released with a thank-you',
          },
          {
            author: 'kimaki',
            time: 'Yesterday at 7:59 PM',
            text: "booked the venue and sent the confirmation around. you're clear until the 2pm deck review.",
          },
        ],
      },
    ],
  },
  {
    id: 'sales-outbound',
    name: 'sales-outbound',
    threads: [
      {
        id: 'overnight-pipeline',
        name: 'overnight pipeline',
        messages: [
          {
            author: 'kimaki',
            time: 'Today at 3:59 PM',
            text: 'Hey Armand, good to meet you. What do you want me around for? Anything concrete, or more of a general sidekick?',
          },
          {
            author: 'user',
            time: 'Today at 3:59 PM',
            text: 'Overnight pipeline generation and outbound.\n\nPick eligible prospects from this Google Sheet, research them on the web, grab context on contacts and accounts from Hex, Sumble, and Salesforce. Draft email and LinkedIn sequences in my voice.',
          },
          {
            author: 'kimaki',
            time: 'Today at 4:00 PM',
            text: 'Done.',
            image: {
              src: '/playground/gen-3.jpg',
              width: 800,
              height: 448,
            },
          },
        ],
      },
      {
        id: 'send-the-top-10',
        name: 'send the top 10',
        messages: [
          {
            author: 'user',
            time: 'Today at 4:00 PM',
            text: 'The top 10 look good. Send it. Run this every week.',
          },
          {
            author: 'system',
            text: 'Created routine · Overnight outbound',
          },
          {
            author: 'kimaki',
            time: 'Today at 4:00 PM',
            text: 'Done.',
          },
        ],
      },
    ],
  },
  {
    id: 'image-gen',
    name: 'image-gen',
    threads: [
      {
        id: 'soft-light-still',
        name: 'soft light still',
        messages: [
          {
            author: 'user',
            time: 'Today at 1:12 PM',
            text: 'generate a still. pale light, almost nothing in it.',
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
          },
        ],
      },
      {
        id: 'darkroom-streak',
        name: 'darkroom streak',
        messages: [
          {
            author: 'user',
            time: 'Today at 1:18 PM',
            text: 'darker this time. one streak of light.',
          },
          {
            author: 'kimaki',
            time: 'Today at 1:19 PM',
            text: 'uploaded.',
            image: {
              src: '/playground/gen-2.jpg',
              width: 800,
              height: 533,
            },
          },
        ],
      },
      {
        id: 'violet-grain',
        name: 'violet grain',
        messages: [
          {
            author: 'user',
            time: 'Today at 1:22 PM',
            text: 'grain, violet, like a scan.',
          },
          {
            author: 'kimaki',
            time: 'Today at 1:23 PM',
            text: 'done.',
            image: {
              src: '/playground/gen-3.jpg',
              width: 800,
              height: 448,
            },
          },
        ],
      },
    ],
  },
  {
    id: 'inbox-manager',
    name: 'inbox-manager',
    threads: [
      {
        id: 'inbox-at-zero',
        name: 'inbox at zero',
        messages: [
          {
            author: 'user',
            time: 'Today at 11:59 AM',
            text: 'inbox got away from me over the weekend, sweep it?',
          },
          {
            author: 'kimaki',
            time: 'Today at 11:59 AM',
            text: "on it. 41 unread since friday. archiving the noise, drafting the rest.",
          },
          {
            author: 'kimaki',
            time: 'Today at 12:59 PM',
            text: '✓ Archived → 26 newsletters + receipts\n✓ Replied → 9 routine threads · scheduling and intros\n✓ Drafted → 6 that sound like you · held for your read\n✓ Flagged → 1 from dana · contract question',
          },
          {
            author: 'kimaki',
            time: 'Today at 12:59 PM',
            text: "dana's asking whether the renewal covers the new seats. her draft answers yes and quotes the contract line. it's at the top of the held pile.",
          },
          {
            author: 'user',
            time: 'Today at 12:59 PM',
            text: "send dana's, i'll take the rest tomorrow",
          },
          {
            author: 'kimaki',
            time: 'Today at 12:59 PM',
            text: 'sent. inbox is at zero, with 5 drafts parked for tomorrow.',
          },
        ],
      },
    ],
  },
  {
    id: 'account-manager',
    name: 'account-manager',
    threads: [
      {
        id: 'acme-renewal',
        name: 'acme renewal',
        messages: [
          {
            author: 'user',
            time: 'Today at 9:59 AM',
            text: "where are we with acme? renewal can't sneak up on us",
          },
          {
            author: 'kimaki',
            time: 'Today at 9:59 AM',
            text: 'pulling usage, open threads, and the exec notes together now.',
          },
          {
            author: 'kimaki',
            time: 'Today at 10:59 AM',
            text: 'acme renews in 60 days:\n✓ Usage → 214 seats active · up 18% this quarter\n✓ Threads → 2 open · security review + a pricing question\n✓ Next step → renewal call with vicky drafted · week of the 18th',
          },
          {
            author: 'kimaki',
            time: 'Today at 10:59 AM',
            text: "globex is the quiet one: nothing since the pilot wrapped. i wrote a re-engagement note that leads with their own pilot numbers. it's in drafts, not sent.",
          },
          {
            author: 'user',
            time: 'Today at 10:59 AM',
            text: "send the acme invite. hold globex until i've read the note",
          },
          {
            author: 'system',
            text: 'Memory updated',
          },
          {
            author: 'kimaki',
            time: 'Today at 10:59 AM',
            text: "invite's out to vicky. the globex note is holding in drafts, and quiet-account sends wait for your read from now on.",
          },
        ],
      },
    ],
  },
  {
    id: 'talent-scout',
    name: 'talent-scout',
    threads: [
      {
        id: 'three-intros',
        name: '3 intros',
        messages: [
          {
            author: 'user',
            time: 'Yesterday at 3:59 PM',
            text: 'take the platform engineer req: senior, infra-heavy, remote ok. source quietly.',
          },
          {
            author: 'kimaki',
            time: 'Yesterday at 3:59 PM',
            text: "on it. i'll screen overnight against the req and skip anyone already in the ats.",
          },
          {
            author: 'kimaki',
            time: 'Today at 6:59 AM',
            text: 'overnight run:\n✓ Sourced → 64 profiles matched the req\n✓ Skipped → 11 already in the ats\n✓ Shortlist → 12 screened · notes on each',
          },
          {
            author: 'kimaki',
            time: 'Today at 6:59 AM',
            text: 'three worth your time first:\nMara Iyer → scaled ingest 40× at a data startup · writes like an owner\nTomás Rivera → runs a 6-person infra team · wants to build again\nGrace Osei → your exact stack end to end · shipped the migration you keep citing',
          },
          {
            author: 'user',
            time: 'Today at 7:59 AM',
            text: 'strong list, mara especially. draft the intros',
          },
          {
            author: 'kimaki',
            time: 'Today at 7:59 AM',
            text: "3 intros drafted in your voice and held for your ok. nothing sends until you've read them.",
          },
        ],
      },
    ],
  },
  {
    id: 'expense-manager',
    name: 'expense-manager',
    threads: [
      {
        id: 'month-end-close',
        name: 'month-end close',
        messages: [
          {
            author: 'user',
            time: 'Yesterday at 3:59 PM',
            text: 'month-end is friday, close out the card for me?',
          },
          {
            author: 'kimaki',
            time: 'Yesterday at 3:59 PM',
            text: "i'll match every charge to a receipt and file the report. anything that doesn't line up, i ask instead of guessing.",
          },
          {
            author: 'system',
            text: 'Created routine · Month-end close',
          },
          {
            author: 'kimaki',
            time: 'Today at 10:59 AM',
            text: '✓ Receipts → 9 matched to card charges\n✓ Report → drafted · $2,340 across 3 trips\n✓ Flagged → 1 charge · harbor hotel, $412 twice',
          },
          {
            author: 'kimaki',
            time: 'Today at 10:59 AM',
            text: 'the harbor hotel charged $412 on the 12th and again on the 14th. double-billed, or two separate nights?',
          },
          {
            author: 'user',
            time: 'Today at 11:59 AM',
            text: 'two nights, mia stayed the second one',
          },
          {
            author: 'kimaki',
            time: 'Today at 11:59 AM',
            text: 'that clears it. report filed: 9 receipts matched, $2,340 across 3 trips, nothing outstanding.',
          },
        ],
      },
    ],
  },
]

const DEFAULT_THREAD_ID = 'overnight-pipeline'

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
      className='pointer-events-none absolute left-[2.85em] w-0 border-l-[2px] border-[#4e5058]'
      style={{
        top: '0.15em',
        height: `calc(${count} * 2em - 1.15em)`,
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

function SearchIcon() {
  return (
    <svg width='1em' height='1em' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
      <path
        fill='currentColor'
        fillRule='evenodd'
        d='M15.62 17.03a9 9 0 1 1 1.41-1.41l4.68 4.67a1 1 0 0 1-1.42 1.42l-4.67-4.68ZM17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z'
        clipRule='evenodd'
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
  const channel = CHANNELS[1]
  return { channel, thread: channel.threads[0] }
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

export function DiscordPlayground() {
  const [selectedThreadId, setSelectedThreadId] = useState(DEFAULT_THREAD_ID)
  const [draft, setDraft] = useState('')
  const [liveMessages, setLiveMessages] = useState<
    Record<string, PlaygroundMessage[]>
  >({})
  const { channel, thread } = findThread(selectedThreadId)
  const messages = [...thread.messages, ...(liveMessages[selectedThreadId] ?? [])]
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [selectedThreadId, messages.length])

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
      className='relative flex w-full flex-col overflow-hidden rounded-[1.5em] bg-[#1e1f22] font-normal text-[#dbdee1] shadow-[0_1.5em_5em_rgba(0,0,0,0.45)] ring-1 ring-white/10 pointer-events-none lg:pointer-events-auto'
      style={{
        fontFamily:
          '"gg sans", "Noto Sans", Inter, "Helvetica Neue", Helvetica, Arial, sans-serif',
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
                          className='flex h-[2em] items-stretch pl-[2.85em]'
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
              <span className='truncate'>{thread.name}</span>
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
                {thread.name}
              </div>
              <p className='mt-[0.25em] text-[0.875em] leading-[1.25em] text-[#b5bac1]'>
                Started from{' '}
                <span className='font-medium text-[#dbdee1]'>
                  #{channel.name}
                </span>
                . This is the start of the thread.
              </p>
            </div>
            {messages.map((message, index) => {
              if (message.author === 'system') {
                return (
                  <div
                    key={`system-${index}`}
                    className='px-[1em] py-[0.5em] text-center text-[0.75em] text-[#949ba4]'
                  >
                    {message.text}
                  </div>
                )
              }
              const prev = messages[index - 1]
              const grouped = prev && prev.author === message.author
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
                    {message.text && (
                      <div className='whitespace-pre-wrap text-[1em] leading-[1.375em] text-[#dbdee1]'>
                        {message.text}
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
                    {message.cta && <DiscordButton />}
                  </div>
                </div>
              )
            })}
            <div ref={messagesEndRef} />
          </div>

          <div className='shrink-0 px-[1em] pb-[1.5em] pt-[0.25em]'>
            <div className='mb-[0.4em] flex h-[1.5em] items-center gap-[0.5em] pl-[0.15em] text-[0.875em] leading-none'>
              <span className='flex items-center gap-[0.18em]'>
                <span
                  className='size-[0.4em] rounded-full bg-[#b5bac1]'
                  style={{
                    animation: 'discord-typing-dot 1.4s ease-in-out infinite',
                  }}
                />
                <span
                  className='size-[0.4em] rounded-full bg-[#b5bac1]'
                  style={{
                    animation:
                      'discord-typing-dot 1.4s ease-in-out 0.16s infinite',
                  }}
                />
                <span
                  className='size-[0.4em] rounded-full bg-[#b5bac1]'
                  style={{
                    animation:
                      'discord-typing-dot 1.4s ease-in-out 0.32s infinite',
                  }}
                />
              </span>
              <span className='text-[#dbdee1]'>
                <span className='font-medium'>Kimaki</span>
                <span className='text-[#949ba4]'> is typing...</span>
              </span>
            </div>
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
                placeholder={`Message ${thread.name}`}
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
