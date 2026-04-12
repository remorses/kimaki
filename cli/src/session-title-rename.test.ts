// Unit tests for deriveThreadNameFromSessionTitle — the pure helper that
// decides whether (and how) to rename a Discord thread based on an
// OpenCode session title. Kept focused and deterministic; no Discord mocks.

import { describe, test, expect } from 'vitest'
import { deriveThreadNameFromSessionTitle } from './session-handler/thread-session-runtime.js'

describe('deriveThreadNameFromSessionTitle', () => {
  test('returns trimmed title for plain thread', () => {
    expect(
      deriveThreadNameFromSessionTitle({
        sessionTitle: '  Fix auth bug  ',
        currentName: 'fix the auth',
      }),
    ).toMatchInlineSnapshot(`"Fix auth bug"`)
  })

  test('preserves worktree prefix from current name', () => {
    expect(
      deriveThreadNameFromSessionTitle({
        sessionTitle: 'Refactor queue',
        currentName: '⬦ refactor queue old',
      }),
    ).toMatchInlineSnapshot(`"⬦ Refactor queue"`)
  })

  test('ignores placeholder "New Session -" titles', () => {
    expect(
      deriveThreadNameFromSessionTitle({
        sessionTitle: 'New Session - 2025-01-02',
        currentName: 'whatever',
      }),
    ).toMatchInlineSnapshot(`undefined`)
  })

  test('ignores case-insensitive placeholder titles', () => {
    expect(
      deriveThreadNameFromSessionTitle({
        sessionTitle: 'new session -abc',
        currentName: 'whatever',
      }),
    ).toMatchInlineSnapshot(`undefined`)
  })

  test('returns undefined when candidate already matches current name', () => {
    expect(
      deriveThreadNameFromSessionTitle({
        sessionTitle: 'Fix auth bug',
        currentName: 'Fix auth bug',
      }),
    ).toMatchInlineSnapshot(`undefined`)
  })

  test('returns undefined when candidate (with worktree prefix) already matches', () => {
    expect(
      deriveThreadNameFromSessionTitle({
        sessionTitle: 'Refactor queue',
        currentName: '⬦ Refactor queue',
      }),
    ).toMatchInlineSnapshot(`undefined`)
  })

  test('truncates to 100 chars including worktree prefix', () => {
    const result = deriveThreadNameFromSessionTitle({
      sessionTitle: 'x'.repeat(200),
      currentName: '⬦ seed',
    })
    expect(result?.length).toMatchInlineSnapshot(`100`)
    expect(result?.startsWith('⬦ ')).toMatchInlineSnapshot(`true`)
  })

  test('truncates to 100 chars without prefix', () => {
    const result = deriveThreadNameFromSessionTitle({
      sessionTitle: 'y'.repeat(200),
      currentName: 'seed',
    })
    expect(result?.length).toMatchInlineSnapshot(`100`)
  })

  test('returns undefined for empty string', () => {
    expect(
      deriveThreadNameFromSessionTitle({
        sessionTitle: '',
        currentName: 'seed',
      }),
    ).toMatchInlineSnapshot(`undefined`)
  })

  test('returns undefined for whitespace-only title', () => {
    expect(
      deriveThreadNameFromSessionTitle({
        sessionTitle: '   ',
        currentName: 'seed',
      }),
    ).toMatchInlineSnapshot(`undefined`)
  })

  test('preserves btw: prefix from current name', () => {
    expect(
      deriveThreadNameFromSessionTitle({
        sessionTitle: 'Side question about auth',
        currentName: 'btw: why is auth broken',
      }),
    ).toMatchInlineSnapshot(`"btw: Side question about auth"`)
  })

  test('preserves Fork: prefix from current name', () => {
    expect(
      deriveThreadNameFromSessionTitle({
        sessionTitle: 'Forked task title',
        currentName: 'Fork: old session title',
      }),
    ).toMatchInlineSnapshot(`"Fork: Forked task title"`)
  })

  test('returns undefined for null/undefined title', () => {
    expect(
      deriveThreadNameFromSessionTitle({
        sessionTitle: null,
        currentName: 'seed',
      }),
    ).toMatchInlineSnapshot(`undefined`)
    expect(
      deriveThreadNameFromSessionTitle({
        sessionTitle: undefined,
        currentName: 'seed',
      }),
    ).toMatchInlineSnapshot(`undefined`)
  })
})
