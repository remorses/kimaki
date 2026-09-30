// Replays recorded OpenCode V2 event fixtures (docs/opencode-v2-events) through
// the pure reducer, like the event loop does for one thread (spec 29.3).

import fs from 'node:fs'
import path from 'node:path'
import type { V2Event } from '@opencode/client'

import { emptyView, reduce, type Effect, type Prefs, type ThreadEvent, type ThreadView } from '../thread-reducer.ts'
import type { UiMessage } from '../ui-prompts.ts'
import { ButtonStyle, ComponentType } from 'discord.js'

const FIXTURES_DIR = path.join(import.meta.dirname, '../../../docs/opencode-v2-events')

export function loadFixture(file: string): V2Event[] {
  return fs
    .readFileSync(path.join(FIXTURES_DIR, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { event: V2Event }).event)
}

export function rootSessionId(events: V2Event[]): string {
  const created = events.find((event) => event.type === 'session.created' && !event.data.parentID)
  if (!created || created.type !== 'session.created') throw new Error('fixture has no root session.created')
  return created.data.sessionID
}

export const DEFAULT_PREFS: Prefs = {
  verbosity: 'tools',
  contextLimits: { 'openai/gpt-6-luna': 400_000 },
}

export function replay({
  events,
  prefs = DEFAULT_PREFS,
  view: initial,
}: {
  events: ThreadEvent[]
  prefs?: Prefs
  view?: ThreadView
}): { view: ThreadView; effects: Effect[] } {
  const start =
    initial ??
    emptyView({
      threadId: 'thread',
      sessionId: rootSessionId(events.filter((event): event is V2Event => !event.type.startsWith('kimaki.'))),
      folder: 'project',
      isNew: true,
    })
  return events.reduce<{ view: ThreadView; effects: Effect[] }>(
    (acc, event) => {
      const result = reduce({ view: acc.view, event, prefs })
      return { view: result.view, effects: [...acc.effects, ...result.effects] }
    },
    { view: { ...start, branch: 'main' }, effects: [] },
  )
}

// "content {button labels / select placeholders}" for interactive messages.
function uiLine(message: UiMessage): string {
  const controls = message.components.flatMap((row) =>
    row.components.map((component) => {
      if (component.type === ComponentType.Button) return component.style === ButtonStyle.Premium ? 'sku' : (component.label ?? '')
      if (component.type === ComponentType.StringSelect) return component.options.map((option) => option.label).join('/')
      return String(component.type)
    }),
  )
  return controls.length > 0 ? `${message.content} {${controls.join(', ')}}` : message.content
}

// One readable line per effect, for inline snapshots.
export function effectLines(effects: Effect[]): string[] {
  return effects.map((effect) => {
    if (effect.type === 'typing') return `[typing ${effect.on ? 'on' : 'off'}]`
    if (effect.type === 'markdown') return `${effect.blankLineBefore ? '\\n' : ''}${effect.text}`
    if (effect.type === 'show') {
      const reply = effect.replyTo ? ` reply to ${effect.replyTo}` : ''
      return `[show ${effect.key}${reply}] ${effect.messages.map(uiLine).join(' | ')}`
    }
    if (effect.type === 'edit') return `[edit ${effect.messageId}] ${uiLine(effect.message)}`
    return effect.text.replace(/^\n/, '\\n')
  })
}
