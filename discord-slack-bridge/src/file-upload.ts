// Handles file uploads from Discord to Slack.
//
// Discord sends file attachments as URLs in the message body.
// Slack requires a 2-step upload flow:
//   1. files.getUploadURLExternal → get a presigned URL
//   2. PUT the file content to that URL
//   3. files.completeUploadExternal → share the file to the channel/thread
//
// This module downloads Discord attachment URLs and re-uploads to Slack.

import type {
  FilesCompleteUploadExternalArguments,
  FilesGetUploadURLExternalArguments,
  WebClient,
} from '@slack/web-api'

export interface DiscordAttachment {
  id: string
  filename: string
  size: number
  url: string
  proxy_url?: string
  content_type?: string
}

/**
 * Upload Discord attachments to a Slack channel/thread.
 * Downloads each file from Discord's CDN and re-uploads via Slack's 2-step flow.
 */
export async function uploadAttachmentsToSlack({
  slack,
  attachments,
  channel,
  threadTs,
}: {
  slack: WebClient
  attachments: DiscordAttachment[]
  channel: string
  threadTs?: string
}): Promise<void> {
  if (attachments.length === 0) {
    return
  }

  for (const attachment of attachments) {
    await uploadSingleFile({
      slack,
      attachment,
      channel,
      threadTs,
    })
  }
}

async function uploadSingleFile({
  slack,
  attachment,
  channel,
  threadTs,
}: {
  slack: WebClient
  attachment: DiscordAttachment
  channel: string
  threadTs?: string
}): Promise<void> {
  // Step 1: Download the file from Discord
  const response = await fetch(attachment.url)
  if (!response.ok) {
    throw new Error(
      `Failed to download attachment ${attachment.filename}: ${response.status}`,
    )
  }
  const fileBuffer = Buffer.from(await response.arrayBuffer())

  // Step 2: Get upload URL from Slack
  const uploadUrlArgs = {
    filename: attachment.filename,
    length: fileBuffer.length,
  } satisfies FilesGetUploadURLExternalArguments
  const uploadResult = await slack.files.getUploadURLExternal(uploadUrlArgs)

  if (!uploadResult.ok || !uploadResult.upload_url || !uploadResult.file_id) {
    throw new Error(
      `Failed to get Slack upload URL: ${uploadResult.error ?? 'unknown error'}`,
    )
  }

  // Step 3: Upload file bytes to the presigned URL.
  // Slack docs currently describe POST, but some upload URLs accept PUT.
  // We try POST first and fall back to PUT for compatibility.
  const contentType = attachment.content_type ?? 'application/octet-stream'
  const uploadResponse = await uploadToSlackUrl({
    uploadUrl: uploadResult.upload_url,
    fileBuffer,
    contentType,
  })

  if (!uploadResponse.ok) {
    throw new Error(
      `Failed to upload file to Slack: ${uploadResponse.status}`,
    )
  }

  // Step 4: Complete the upload (shares file to channel)
  // Slack's arg type is a destination union: channel-only or thread reply.
  const files: [{ id: string; title: string }] = [
    { id: uploadResult.file_id, title: attachment.filename },
  ]
  const completeArgs: FilesCompleteUploadExternalArguments = threadTs
    ? {
        files,
        channel_id: channel,
        thread_ts: threadTs,
      }
    : {
        files,
        channel_id: channel,
      }
  await slack.files.completeUploadExternal(completeArgs)
}

async function uploadToSlackUrl({
  uploadUrl,
  fileBuffer,
  contentType,
}: {
  uploadUrl: string
  fileBuffer: Buffer
  contentType: string
}): Promise<Response> {
  const postResponse = await fetch(uploadUrl, {
    method: 'POST',
    body: fileBuffer,
    headers: {
      'Content-Type': contentType,
    },
  })
  if (postResponse.ok) {
    return postResponse
  }

  return fetch(uploadUrl, {
    method: 'PUT',
    body: fileBuffer,
    headers: {
      'Content-Type': contentType,
    },
  })
}
