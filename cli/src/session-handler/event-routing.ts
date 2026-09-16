export function shouldRouteEventToRuntime({
  eventType,
  eventSessionId,
  toastSessionId,
  activeSessionId,
  isSubtaskSession,
}: {
  eventType: string
  eventSessionId: string | undefined
  toastSessionId: string | undefined
  activeSessionId: string | undefined
  isSubtaskSession: boolean
}): boolean {
  if (eventType === 'tui.toast.show') {
    if (!toastSessionId) return true
    return toastSessionId === activeSessionId || isSubtaskSession
  }
  if (!eventSessionId) return true
  return eventSessionId === activeSessionId || isSubtaskSession
}
