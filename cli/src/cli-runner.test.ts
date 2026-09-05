import { describe, expect, test } from 'vitest'
import { REST } from 'discord.js'
import {
  getOpenUrlCommand,
  isTransientNetworkError,
  resolveDiscordUserOption,
} from './cli-runner.js'

test('raw Discord user ID does not invent a username', async () => {
  const user = await resolveDiscordUserOption({
    user: '535922349652836367',
    guildId: '1422625037164351591',
    rest: new REST(),
  })

  expect(user).toEqual({ id: '535922349652836367' })
})

describe('getOpenUrlCommand', () => {
  const installUrl = 'https://kimaki.dev/discord-install?clientId=abc&clientSecret=def'

  test('uses a shell-free opener on Windows', () => {
    expect(getOpenUrlCommand(installUrl, 'win32')).toEqual({
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', installUrl],
    })
  })

  test('uses open on macOS', () => {
    expect(getOpenUrlCommand(installUrl, 'darwin')).toEqual({
      command: 'open',
      args: [installUrl],
    })
  })

  test('uses xdg-open on Linux', () => {
    expect(getOpenUrlCommand(installUrl, 'linux')).toEqual({
      command: 'xdg-open',
      args: [installUrl],
    })
  })
})

describe('isTransientNetworkError', () => {
  test('treats TLS leaf verification failures as transient', () => {
    const error = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    })
    expect(isTransientNetworkError(error)).toBe(true)
  })

  test('matches TLS cert failures by message when code is missing', () => {
    expect(
      isTransientNetworkError(new Error('unable to verify the first certificate')),
    ).toBe(true)
  })

  test('walks cause chains for nested TLS errors', () => {
    const cause = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    })
    expect(isTransientNetworkError(new Error('Discord login failed', { cause }))).toBe(
      true,
    )
  })

  test('keeps fatal auth-style errors non-transient', () => {
    expect(isTransientNetworkError(new Error('An invalid token was provided.'))).toBe(
      false,
    )
    expect(isTransientNetworkError(new Error('Used disallowed intents'))).toBe(false)
  })

  test('still treats classic socket codes as transient', () => {
    const error = Object.assign(new Error('getaddrinfo ENOTFOUND'), {
      code: 'ENOTFOUND',
    })
    expect(isTransientNetworkError(error)).toBe(true)
  })

  test('treats undici connect timeouts as transient', () => {
    const error = Object.assign(
      new Error(
        'Connect Timeout Error (attempted address: discord-gateway.kimaki.dev:443, timeout: 10000ms)',
      ),
      {
        name: 'ConnectTimeoutError',
        code: 'UND_ERR_CONNECT_TIMEOUT',
      },
    )
    expect(isTransientNetworkError(error)).toBe(true)
  })

  test('matches undici connect timeouts by message when code is missing', () => {
    expect(
      isTransientNetworkError(
        new Error(
          'Connect Timeout Error (attempted address: discord-gateway.kimaki.dev:443, timeout: 10000ms)',
        ),
      ),
    ).toBe(true)
  })

  test('walks cause chains for nested undici connect timeouts', () => {
    const cause = Object.assign(
      new Error(
        'Connect Timeout Error (attempted address: discord-gateway.kimaki.dev:443, timeout: 10000ms)',
      ),
      {
        name: 'ConnectTimeoutError',
        code: 'UND_ERR_CONNECT_TIMEOUT',
      },
    )
    expect(
      isTransientNetworkError(new Error('Failed to connect to Discord', { cause })),
    ).toBe(true)
  })

  test('treats other undici timeout and socket codes as transient', () => {
    for (const [name, code] of [
      ['HeadersTimeoutError', 'UND_ERR_HEADERS_TIMEOUT'],
      ['BodyTimeoutError', 'UND_ERR_BODY_TIMEOUT'],
      ['SocketError', 'UND_ERR_SOCKET'],
    ] as const) {
      const error = Object.assign(new Error(name), { name, code })
      expect(isTransientNetworkError(error)).toBe(true)
    }
  })
})
