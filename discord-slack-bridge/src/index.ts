// Public exports for discord-slack-bridge.
// Runtime-specific implementations live in dedicated files.

export type { SlackBridgeConfig } from './types.js'
export {
  encodeThreadId,
  decodeThreadId,
  encodeMessageId,
  decodeMessageId,
  isThreadChannelId,
  resolveSlackTarget,
  slackTsToIso,
  resolveDiscordChannelId,
} from './id-converter.js'
export { mrkdwnToMarkdown, markdownToMrkdwn } from './format-converter.js'
export { componentsToBlocks } from './component-converter.js'
export { uploadAttachmentsToSlack } from './file-upload.js'
export { SlackBridge } from './node-bridge.js'
