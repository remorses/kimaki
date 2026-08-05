import { describe, expect, test } from 'vitest'
import { shouldRouteEventToRuntime } from './event-routing.js'

describe('shouldRouteEventToRuntime', () => {
  test('routes events for the active session', () => {
    expect(
      shouldRouteEventToRuntime({
        eventType: 'message.part.updated',
        eventSessionId: 'ses_active',
        toastSessionId: undefined,
        activeSessionId: 'ses_active',
        isSubtaskSession: false,
      }),
    ).toBe(true)
  })

  test('drops foreign session events before they enter the runtime queue', () => {
    expect(
      shouldRouteEventToRuntime({
        eventType: 'message.part.updated',
        eventSessionId: 'ses_foreign',
        toastSessionId: undefined,
        activeSessionId: 'ses_active',
        isSubtaskSession: false,
      }),
    ).toBe(false)
  })

  test('routes subtask session events', () => {
    expect(
      shouldRouteEventToRuntime({
        eventType: 'message.part.updated',
        eventSessionId: 'ses_subtask',
        toastSessionId: undefined,
        activeSessionId: 'ses_active',
        isSubtaskSession: true,
      }),
    ).toBe(true)
  })

  test('routes global toasts but drops toasts scoped to another session', () => {
    expect(
      shouldRouteEventToRuntime({
        eventType: 'tui.toast.show',
        eventSessionId: undefined,
        toastSessionId: undefined,
        activeSessionId: 'ses_active',
        isSubtaskSession: false,
      }),
    ).toBe(true)
    expect(
      shouldRouteEventToRuntime({
        eventType: 'tui.toast.show',
        eventSessionId: undefined,
        toastSessionId: 'ses_foreign',
        activeSessionId: 'ses_active',
        isSubtaskSession: false,
      }),
    ).toBe(false)
  })
})
