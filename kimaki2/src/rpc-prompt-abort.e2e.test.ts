import { expect, test } from 'vitest'
import { bootKimaki2E2e, TEXT_CHANNEL_ID, waitForThreadText } from './e2e-boot.ts'
import { kimakiRpc } from './kimaki-rpc.ts'

test('rpc prompt follows up in an existing thread', async () => {
  const boot = await bootKimaki2E2e({
    dirName: 'kimaki2-rpc-prompt',
  })
  try {
    const kimaki = kimakiRpc({ url: boot.server.serve.url, password: boot.server.serve.password })
    const location = { directory: boot.projectDirectory }
    const started = await kimaki.send(
      {
        channelID: TEXT_CHANNEL_ID,
        prompt: 'Reply with exactly: rpc-start',
      },
      { location },
    )
    await waitForThreadText({
      discord: boot.discord,
      threadId: started.threadID,
      includes: '*project ⋅ main ⋅',
    })
    await kimaki.prompt(
      {
        threadID: started.threadID,
        prompt: 'Reply with exactly: rpc-follow',
      },
      { location },
    )
    await waitForThreadText({
      discord: boot.discord,
      threadId: started.threadID,
      includes: '*project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*\nok\n*project ⋅ main ⋅',
    })
    expect(await boot.discord.thread(started.threadID).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      *using deterministic-provider/deterministic-v2*
      ok
      *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
      ok
      *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
    `)
  } finally {
    await boot.stop()
  }
}, 30_000)

test('rpc prompt and abort unknown_thread errors', async () => {
  const boot = await bootKimaki2E2e({
    dirName: 'kimaki2-rpc-unknown-thread',
  })
  try {
    const kimaki = kimakiRpc({ url: boot.server.serve.url, password: boot.server.serve.password })
    const location = { directory: boot.projectDirectory }
    const promptFailed = await kimaki
      .prompt(
        {
          threadID: 'missing-thread',
          prompt: 'Reply with exactly: rpc-follow',
        },
        { location },
      )
      .then(
        () => null,
        (error) => error,
      )
    const abortFailed = await kimaki.abort({ threadID: 'missing-thread' }, { location }).then(
      () => null,
      (error) => error,
    )
    expect(promptFailed).toMatchObject({ type: 'unknown_thread' })
    expect(abortFailed).toMatchObject({ type: 'unknown_thread' })
  } finally {
    await boot.stop()
  }
}, 30_000)
