// Slack-style ID generation for test fixtures.
// Slack IDs are prefixed strings: T (workspace), C (channel), U (user).
// Message timestamps are Unix seconds with microsecond precision: "1700000001.000001"

let workspaceCounter = 0
let channelCounter = 0
let userCounter = 0
let messageCounter = 0

export function generateWorkspaceId(): string {
  workspaceCounter++
  return `T${String(workspaceCounter).padStart(9, '0')}`
}

export function generateChannelId(): string {
  channelCounter++
  return `C${String(channelCounter).padStart(9, '0')}`
}

export function generateUserId(): string {
  userCounter++
  return `U${String(userCounter).padStart(9, '0')}`
}

// Generates a Slack-style timestamp (ts) that is unique and monotonically
// increasing. Uses a base epoch + counter to produce deterministic values
// in tests. Format: "XXXXXXXXXX.YYYYYY" (10 digits . 6 digits)
const BASE_EPOCH = 1700000000

export function generateMessageTs(): string {
  messageCounter++
  const seconds = BASE_EPOCH + Math.floor(messageCounter / 1000000)
  const micros = messageCounter % 1000000
  return `${seconds}.${String(micros).padStart(6, '0')}`
}

export function resetIds(): void {
  workspaceCounter = 0
  channelCounter = 0
  userCounter = 0
  messageCounter = 0
}
