import { expect, expectTypeOf, it } from 'vitest'
import {
  DEFAULT_CLAUDE_ACCOUNT_PREFS,
  type ClaudeAccount,
  type ClaudeAccountView,
  type ClaudeRoutingMode,
  type ClaudeSessionAccount,
  type ClaudeUsageSnapshot,
  type PlanUsageWindow,
} from './providers'
import { DEFAULT_APP_PREFS, DEFAULT_CLAUDE_ACCOUNT_PREFS as facadeDefault } from '../models'

it('providers keeps nullable account and usage fields and routing modes', () => {
  expectTypeOf<ClaudeAccount['credentialDir']>().toEqualTypeOf<string | null>()
  expectTypeOf<ClaudeAccountView['usage']>().toEqualTypeOf<ClaudeUsageSnapshot | null>()
  expectTypeOf<PlanUsageWindow['resetsAt']>().toEqualTypeOf<number | null>()
  expectTypeOf<ClaudeSessionAccount['alternative']>().toEqualTypeOf<{
    id: string
    label: string
  } | null>()
  expectTypeOf<ClaudeRoutingMode>().toEqualTypeOf<'specific' | 'ordered' | 'round-robin'>()
})

it('providers shares the unchanged mutable account default with the facade and app', () => {
  expect(DEFAULT_CLAUDE_ACCOUNT_PREFS).toEqual({
    accounts: [],
    mode: 'specific',
    cursor: 0,
    cooldowns: {},
    bindings: {},
  })
  expect(DEFAULT_CLAUDE_ACCOUNT_PREFS).toBe(facadeDefault)
  expect(DEFAULT_APP_PREFS.claudeAccounts).toBe(DEFAULT_CLAUDE_ACCOUNT_PREFS)
  expect(Object.isFrozen(DEFAULT_CLAUDE_ACCOUNT_PREFS.accounts)).toBe(false)
})
