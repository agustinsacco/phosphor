import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/models'
import { cacheChurn, headroomCoverage, longSession, mcpWeight } from './advisor-rules'

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    path: '/s/a.jsonl',
    sessionId: 'id',
    cwd: '/w',
    createdAt: '2026-09-08T00:00:00.000Z',
    userMessages: 3,
    assistantMessages: 3,
    toolCalls: 2,
    totalTokens: 10_000,
    inputTokens: 5_000,
    outputTokens: 1_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0.1,
    headroomSavedTokens: 0,
    entryCount: 6,
    branchCount: 0,
    mtimeMs: 1,
    lastActivityAt: '2026-09-08T01:00:00.000Z',
    ...overrides,
  }
}

describe('cacheChurn', () => {
  it('returns only the largest cache writer among qualifying lanes', () => {
    const finding = cacheChurn([
      session({ name: 'higher ratio', cacheWriteTokens: 200_000 }),
      session({ name: 'worst', cacheWriteTokens: 300_000, cacheReadTokens: 100_000 }),
      session({ name: 'healthy', cacheWriteTokens: 500_000, cacheReadTokens: 1_000_000 }),
    ])
    expect(finding).toMatchObject({
      id: 'cache-churn',
      severity: 'serious',
      settingsTab: 'claude-provider',
    })
    expect(finding!.detail).toContain('"worst" re-wrote 75%')
  })

  it('returns no finding for empty, small or equally read and written cached traffic', () => {
    expect(cacheChurn([])).toBeUndefined()
    expect(cacheChurn([session({ cacheWriteTokens: 199_999 })])).toBeUndefined()
    expect(
      cacheChurn([session({ cacheWriteTokens: 100_000, cacheReadTokens: 100_000 })]),
    ).toBeUndefined()
  })

  it('includes the cache floor and preserves first input on equal writes', () => {
    const finding = cacheChurn([
      session({
        firstUserText: 'x'.repeat(49),
        cacheWriteTokens: 100_001,
        cacheReadTokens: 99_999,
      }),
      session({ name: 'second', cacheWriteTokens: 100_001, cacheReadTokens: 99_999 }),
    ])
    expect(finding!.detail).toContain(`"${'x'.repeat(48)}…" re-wrote 50%`)
  })
})

describe('headroomCoverage', () => {
  it('advises enabling compression before installation or startup', () => {
    expect(headroomCoverage({ enabled: false, installed: false, proxyRunning: false })).toEqual({
      id: 'headroom-off',
      severity: 'tip',
      title: 'Tool-result compression is off',
      detail:
        'Headroom compresses large JSON tool results losslessly before they enter the ' +
        'context — measured 38–53% on uniform connector payloads. Enable it below.',
      settingsTab: 'optimization',
    })
  })

  it('advises installation before proxy startup', () => {
    expect(headroomCoverage({ enabled: true, installed: false, proxyRunning: false })).toEqual({
      id: 'headroom-missing',
      severity: 'warning',
      title: 'Compression is enabled but Headroom is not installed',
      detail: 'Sessions run uncompressed until it is. Install it below.',
      settingsTab: 'optimization',
    })
  })

  it('advises startup for an installed but stopped proxy', () => {
    expect(headroomCoverage({ enabled: true, installed: true, proxyRunning: false })).toEqual({
      id: 'headroom-down',
      severity: 'warning',
      title: 'The Headroom proxy is not running',
      detail:
        'Compression fails open, so sessions still work — but nothing is being saved. ' +
        'Start the proxy below.',
      settingsTab: 'optimization',
    })
  })

  it('returns no finding when compression is covered', () => {
    expect(headroomCoverage({ enabled: true, installed: true, proxyRunning: true })).toBeUndefined()
  })
})

describe('mcpWeight', () => {
  it.each([0, 2])('returns no finding for %i direct servers', (count) => {
    expect(mcpWeight(count)).toBeUndefined()
  })

  it.each([3, 4])('tips at %i direct servers', (count) => {
    expect(mcpWeight(count)).toMatchObject({
      id: 'mcp-weight',
      severity: 'tip',
      title: `${count} MCP servers expose tools directly`,
      settingsTab: 'connectors',
    })
  })
})

describe('longSession', () => {
  it('returns no finding for empty inputs or sessions below the threshold', () => {
    expect(longSession([])).toBeUndefined()
    expect(longSession([session({ totalTokens: 4_999_999 })])).toBeUndefined()
  })

  it('includes the threshold and falls back to an untitled label', () => {
    expect(longSession([session({ totalTokens: 5_000_000 })])).toMatchObject({
      id: 'long-session',
      severity: 'tip',
      detail:
        '"untitled lane" has consumed 5M tokens. Forking from a bookmark starts a lane that keeps the conclusions and drops ' +
        'the transcript.',
    })
  })

  it('selects the highest total without mutating sessions and preserves the first tie', () => {
    const sessions = [
      session({ name: 'smaller', totalTokens: 5_000_000, cacheWriteTokens: 200_000 }),
      session({ name: 'first largest', totalTokens: 6_600_000, cacheWriteTokens: 300_000 }),
      session({ name: 'tied largest', totalTokens: 6_600_000, cacheWriteTokens: 300_000 }),
    ]
    sessions.forEach(Object.freeze)
    Object.freeze(sessions)
    const before = structuredClone(sessions)
    expect(longSession(sessions)!.detail).toContain('"first largest" has consumed 7M')
    expect(cacheChurn(sessions)!.detail).toContain('"first largest" re-wrote 100%')
    expect(sessions).toEqual(before)
  })
})
