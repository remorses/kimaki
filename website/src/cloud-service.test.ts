// Tests for Kimaki Cloud allowlist, Fly app names, and cleanup error handling.

import { describe, expect, test } from 'vitest'
import { FlyApiError, FlyNotFoundError } from '@fly.io/sdk'
import {
  flyAppNameForMachine,
  flyCleanupFailed,
  flyMachineEnv,
  flyMachineSecrets,
  isCloudProvisionAllowed,
  isFlyMissing,
  parseCloudProvisionAllowlist,
} from './cloud-service.ts'

describe('parseCloudProvisionAllowlist', () => {
  test('treats empty input as nobody allowed', () => {
    expect(parseCloudProvisionAllowlist(undefined).size).toBe(0)
    expect(parseCloudProvisionAllowlist('').size).toBe(0)
    expect(parseCloudProvisionAllowlist('  ,  ').size).toBe(0)
  })

  test('splits emails and Discord ids, ignoring case and spaces', () => {
    expect([
      ...parseCloudProvisionAllowlist(' 535922349652836367, Tommy@example.com '),
    ]).toEqual(['535922349652836367', 'tommy@example.com'])
  })
})

describe('isCloudProvisionAllowed', () => {
  test('denies everyone when the allowlist is empty', () => {
    expect(
      isCloudProvisionAllowed({
        allowlist: new Set(),
        email: 'tommy@example.com',
        discordAccountId: '535922349652836367',
      }),
    ).toBe(false)
  })

  test('matches Discord account id or email', () => {
    const allowlist = parseCloudProvisionAllowlist(
      '535922349652836367,tommy@example.com',
    )
    expect(
      isCloudProvisionAllowed({
        allowlist,
        email: 'other@example.com',
        discordAccountId: '535922349652836367',
      }),
    ).toBe(true)
    expect(
      isCloudProvisionAllowed({
        allowlist,
        email: 'Tommy@example.com',
        discordAccountId: '0',
      }),
    ).toBe(true)
    expect(
      isCloudProvisionAllowed({
        allowlist,
        email: 'other@example.com',
        discordAccountId: '0',
      }),
    ).toBe(false)
  })
})

describe('flyAppNameForMachine', () => {
  test('uses a per-machine random suffix so a user can create more than one app', () => {
    const names = new Set(
      Array.from({ length: 20 }, () =>
        flyAppNameForMachine({ userId: 'abc-def-1234' }),
      ),
    )
    expect(names.size).toBe(20)
    for (const name of names) {
      expect(name).toMatch(/^kimaki-cloud-abcdef12-[0-9a-f]{8}$/)
    }
  })
})

describe('fly machine config helpers', () => {
  test('machine env has no client secret or bot token', () => {
    const env = flyMachineEnv({
      appName: 'kimaki-cloud-abcdef12-deadbeef',
      clientId: 'client-1',
    })
    expect(env).toEqual({
      NODE_ENV: 'production',
      KIMAKI_CLOUD_FLY_APP: 'kimaki-cloud-abcdef12-deadbeef',
      KIMAKI_CLOUD_CLIENT_ID: 'client-1',
      KIMAKI_LOCK_PORT: '8080',
      KIMAKI_SCALE_TO_ZERO: '1',
    })
    expect(env).not.toHaveProperty('KIMAKI_BOT_TOKEN')
    expect(env).not.toHaveProperty('KIMAKI_CLOUD_CLIENT_SECRET')
  })

  test('secrets stay out of machine env', () => {
    expect(
      flyMachineSecrets({
        clientId: 'client-1',
        clientSecret: 'secret-1',
      }),
    ).toEqual({
      KIMAKI_BOT_TOKEN: 'client-1:secret-1',
    })
  })
})

describe('flyCleanupFailed', () => {
  test('treats 404 as already gone, other Fly errors as cleanup failure', () => {
    const missing = new FlyNotFoundError({ method: 'DELETE', path: '/apps/x' })
    const failed = new FlyApiError({
      method: 'DELETE',
      path: '/apps/x',
      httpStatus: 500,
    })
    expect(isFlyMissing(missing)).toBe(true)
    expect(flyCleanupFailed(missing)).toBe(false)
    expect(flyCleanupFailed(failed)).toBe(true)
    expect(flyCleanupFailed(undefined)).toBe(false)
  })
})
