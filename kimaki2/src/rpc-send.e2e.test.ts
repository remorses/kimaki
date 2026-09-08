import { expect, test } from 'vitest'
import { bootKimaki2E2e, TEXT_CHANNEL_ID, waitForThreadText } from './e2e-boot.ts'
import { opencodeApi } from './opencode2-serve.ts'

test('rpc send starts a Discord thread on a mapped channel', async () => {
  const { discord, stop, projectDirectory, server } = await bootKimaki2E2e({
    dirName: 'kimaki2-rpc-send',
  })
  const result = await opencodeApi({
    url: server.serve.url,
    password: server.serve.password,
    method: 'POST',
    path: '/api/rpc/kimaki/send',
    directory: projectDirectory,
    body: {
      input: {
        channelID: TEXT_CHANNEL_ID,
        prompt: 'Reply with exactly: rpc-send',
      },
    },
  })
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`rpc send ${result.status} ${JSON.stringify(result.body)}`)
  }
  const output = result.body?.output ?? result.body?.data ?? result.body
  const threadID = output?.threadID
  if (typeof threadID !== 'string') {
    throw new Error(`rpc send body ${JSON.stringify(result.body)}`)
  }
  await waitForThreadText({
    discord,
    threadId: threadID,
    includes: '*project ⋅ main ⋅',
  })
  expect(await discord.thread(threadID).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    *using deterministic-provider/deterministic-v2*
    ok
    *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  await stop()
}, 30_000)
