import { describe, it, expect } from 'vitest'
import {
  compactReset,
  isClaudeCliModel,
  usageStroke,
  usageUnavailableReason,
  windowShortTitle,
  windowTitle,
} from './claudeUsage'
import type { ClaudeUsageWindow } from '@shared/models'

const window = (over: Partial<ClaudeUsageWindow>): ClaudeUsageWindow => ({
  label: 'Current session',
  kind: 'five_hour',
  percentUsed: 12,
  resetsAt: null,
  ...over,
})

describe('windowTitle', () => {
  it('names the two windows pidex knows', () => {
    expect(windowTitle(window({}))).toBe('5-hour window')
    expect(windowTitle(window({ kind: 'weekly', label: 'Current week (all models)' }))).toBe(
      'Weekly window',
    )
  })

  it('passes an unknown label through rather than guessing', () => {
    const label = 'One-time credit · Expires Sep 30'
    expect(windowTitle(window({ kind: 'other', label }))).toBe(label)
  })
})

describe('windowShortTitle', () => {
  it('fits under a dial, keeping the model name for the per-model window', () => {
    expect(windowShortTitle(window({}))).toBe('5-hour')
    expect(windowShortTitle(window({ kind: 'weekly', label: 'Current week (all models)' }))).toBe(
      'Weekly',
    )
    expect(windowShortTitle(window({ kind: 'weekly_model', label: 'Current week (Fable)' }))).toBe(
      'Fable',
    )
  })

  it('passes an unknown label through rather than guessing', () => {
    const label = 'One-time credit'
    expect(windowShortTitle(window({ kind: 'other', label }))).toBe(label)
  })
})

describe('compactReset', () => {
  const now = 1_800_000_000_000

  it('drops a unit as the countdown shortens', () => {
    expect(compactReset(now + 5 * 86_400_000 + 16 * 3_600_000, now)).toBe('5d 16h')
    expect(compactReset(now + 4 * 3_600_000 + 18 * 60_000, now)).toBe('4h 18m')
    expect(compactReset(now + 9 * 60_000, now)).toBe('9m')
    // Under a minute still reads as time left, never as "0m".
    expect(compactReset(now + 20_000, now)).toBe('1m')
  })

  it('has nothing to say about an unknown or elapsed reset', () => {
    expect(compactReset(null, now)).toBeNull()
    expect(compactReset(now - 1000, now)).toBeNull()
  })
})

describe('usageStroke', () => {
  it('crosses at the same thresholds as the bars', () => {
    expect(usageStroke(74)).toBe('var(--px-accent)')
    expect(usageStroke(75)).toBe('var(--px-warning)')
    expect(usageStroke(101)).toBe('var(--px-danger)')
  })
})

describe('usageUnavailableReason', () => {
  it('gives a distinct, actionable sentence per failure', () => {
    const reasons = (['claude-not-found', 'run-failed', 'no-usage'] as const).map(
      usageUnavailableReason,
    )
    expect(new Set(reasons).size).toBe(3)
    expect(reasons[0]).toContain('PATH')
    expect(reasons[2]).toContain('sign in')
  })
})

describe('isClaudeCliModel', () => {
  it('matches on either field pi may carry the provider in', () => {
    expect(isClaudeCliModel({ provider: 'pi-claude-cli', api: 'anthropic' })).toBe(true)
    expect(isClaudeCliModel({ provider: 'anthropic', api: 'pi-claude-cli' })).toBe(true)
  })

  it('leaves every other provider alone, including when the model is unknown', () => {
    // Plan usage governs nothing on these, so the section must not appear.
    expect(isClaudeCliModel({ provider: 'anthropic', api: 'anthropic' })).toBe(false)
    expect(isClaudeCliModel({ provider: 'amazon-bedrock', api: 'anthropic' })).toBe(false)
    expect(isClaudeCliModel(undefined)).toBe(false)
    expect(isClaudeCliModel(null)).toBe(false)
  })
})
