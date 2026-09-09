import { expect, test } from 'vitest'
import { bootKimaki2E2e, TEXT_CHANNEL_ID, waitForThreadText } from './e2e-boot.ts'
import { kimakiRpc } from './kimaki-rpc.ts'

test('rpc send starts a Discord thread on a mapped channel', async () => {
  const boot = await bootKimaki2E2e({
    dirName: 'kimaki2-rpc-send',
  })
  try {
    const kimaki = kimakiRpc({ url: boot.server.serve.url, password: boot.server.serve.password })
    const result = await kimaki.send(
      {
        channelID: TEXT_CHANNEL_ID,
        prompt: 'Reply with exactly: rpc-send',
      },
      { location: { directory: boot.projectDirectory } },
    )
    await waitForThreadText({
      discord: boot.discord,
      threadId: result.threadID,
      includes: '*project ⋅ main ⋅',
    })
    expect(await boot.discord.thread(result.threadID).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      *using deterministic-provider/deterministic-v2*
      ok
      *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
    `)
  } finally {
    await boot.stop()
  }
}, 30_000)

test('rpc send unknown_channel errors', async () => {
  const boot = await bootKimaki2E2e({
    dirName: 'kimaki2-rpc-send-unknown',
  })
  try {
    const kimaki = kimakiRpc({ url: boot.server.serve.url, password: boot.server.serve.password })
    const failed = await kimaki
      .send(
        {
          channelID: '999999999999999999',
          prompt: 'nope',
        },
        { location: { directory: boot.projectDirectory } },
      )
      .then(
        () => null,
        (error) => error,
      )
    expect(failed).toMatchObject({ type: 'unknown_channel' })
  } finally {
    await boot.stop()
  }
}, 30_000)
