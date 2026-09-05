// Unit tests for anonymous install id and product event construction.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setDataDir } from './config.js'
import {
  _enableAnalyticsTestCapture,
  _resetAnalyticsForTests,
  commonAnalyticsProps,
  getInstallId,
  initAnalytics,
  INSTALL_ID_FILENAME,
  setAnalyticsBotMode,
  trackEvent,
} from './analytics.js'

describe('analytics', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-analytics-'))
    setDataDir(tmpDir)
    _resetAnalyticsForTests()
  })

  afterEach(() => {
    _resetAnalyticsForTests()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates and reuses install-id', () => {
    const first = getInstallId()
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    expect(
      fs.readFileSync(path.join(tmpDir, INSTALL_ID_FILENAME), 'utf8').trim(),
    ).toBe(first)
    _resetAnalyticsForTests()
    setDataDir(tmpDir)
    expect(getInstallId()).toBe(first)
  })

  it('replaces invalid install-id file contents', () => {
    fs.writeFileSync(path.join(tmpDir, INSTALL_ID_FILENAME), 'not-a-uuid\n')
    const id = getInstallId()
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    expect(id).not.toBe('not-a-uuid')
    expect(
      fs.readFileSync(path.join(tmpDir, INSTALL_ID_FILENAME), 'utf8').trim(),
    ).toBe(id)
  })

  it('no-ops trackEvent under vitest without capture', () => {
    initAnalytics()
    expect(() => {
      trackEvent('bot_started', { guild_count: 1 })
    }).not.toThrow()
  })

  it('KIMAKI_STRADA_ENABLED=0 keeps initAnalytics from throwing', () => {
    const prev = process.env.KIMAKI_STRADA_ENABLED
    process.env.KIMAKI_STRADA_ENABLED = '0'
    try {
      initAnalytics()
      expect(() => {
        trackEvent('bot_started', { guild_count: 1 })
      }).not.toThrow()
    } finally {
      if (prev === undefined) {
        delete process.env.KIMAKI_STRADA_ENABLED
      } else {
        process.env.KIMAKI_STRADA_ENABLED = prev
      }
    }
  })

  it('builds common props and install_id always wins', () => {
    setAnalyticsBotMode('gateway')
    const captured = _enableAnalyticsTestCapture({
      installId: '22222222-2222-4222-8222-222222222222',
      botMode: 'gateway',
    })

    trackEvent('turn_started', {
      install_id: 'should-not-win',
      input_kind: 'prompt',
      ingress_mode: 'direct',
      source: 'discord',
      uses_custom_agent: false,
    })

    expect(captured).toHaveLength(1)
    expect(captured[0]!.name).toBe('turn_started')
    expect(captured[0]!.properties).toMatchObject({
      install_id: '22222222-2222-4222-8222-222222222222',
      schema_version: 1,
      bot_mode: 'gateway',
      platform: process.platform,
      arch: process.arch,
      input_kind: 'prompt',
      ingress_mode: 'direct',
      source: 'discord',
      uses_custom_agent: false,
    })
    expect(captured[0]!.properties.install_id).not.toBe('should-not-win')

    const common = commonAnalyticsProps({ foo: 'bar' })
    expect(common).toMatchObject({
      foo: 'bar',
      install_id: '22222222-2222-4222-8222-222222222222',
      schema_version: 1,
      bot_mode: 'gateway',
    })
  })

  it('emits project_registered session_created turn_completed tokens_used shapes', () => {
    const captured = _enableAnalyticsTestCapture({
      installId: '33333333-3333-4333-8333-333333333333',
      botMode: 'self_hosted',
    })

    trackEvent('project_registered', {
      project_kind: 'user',
      source: 'cli',
      user_project_count: 2,
    })
    trackEvent('session_created', {
      has_worktree: true,
      source: 'discord',
    })
    trackEvent('turn_completed', {
      duration_sec: 42,
    })
    trackEvent('tokens_used', {
      tokens_input: 100,
      tokens_output: 20,
      tokens_reasoning: 5,
      tokens_cache_read: 10,
      tokens_cache_write: 2,
      tokens_total: 137,
      cost: 0,
      assistant_message_count: 2,
      is_subagent: false,
      model: 'gpt-5.3-codex',
      provider: 'openai',
    })

    expect(captured.map((e) => e.name)).toEqual([
      'project_registered',
      'session_created',
      'turn_completed',
      'tokens_used',
    ])
    expect(captured[0]!.properties).toMatchObject({
      project_kind: 'user',
      source: 'cli',
      user_project_count: 2,
      install_id: '33333333-3333-4333-8333-333333333333',
      schema_version: 1,
    })
    expect(captured[1]!.properties).toMatchObject({
      has_worktree: true,
      source: 'discord',
    })
    expect(captured[2]!.properties).toMatchObject({
      duration_sec: 42,
    })
    expect(captured[3]!.properties).toMatchObject({
      tokens_input: 100,
      tokens_output: 20,
      tokens_reasoning: 5,
      tokens_cache_read: 10,
      tokens_cache_write: 2,
      tokens_total: 137,
      cost: 0,
      assistant_message_count: 2,
      is_subagent: false,
      model: 'gpt-5.3-codex',
      provider: 'openai',
      install_id: '33333333-3333-4333-8333-333333333333',
      schema_version: 1,
    })
  })
})
