import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/models'
import { adviseOptimization, type AdvisorInput } from './advisor'

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

function input(overrides: Partial<AdvisorInput> = {}): AdvisorInput {
  return {
    headroom: { enabled: true, installed: true, proxyRunning: true },
    sessions: [],
    mcpServerCount: 0,
    ...overrides,
  }
}

describe('adviseOptimization characterization', () => {
  it.each([
    [100_001, 99_998, false],
    [100_001, 99_999, true],
    [100_000, 100_000, false],
    [100_001, 100_000, true],
    [0, 0, false],
  ])('cache floor and ratio: write %i read %i yields %s', (write, read, expected) => {
    const findings = adviseOptimization(
      input({ sessions: [session({ cacheWriteTokens: write, cacheReadTokens: read })] }),
    )
    expect(findings.map((finding) => finding.id)).toEqual(expected ? ['cache-churn'] : [])
  })

  it('uses cacheRead plus cacheWrite, not totalTokens, for churn percentage and copy', () => {
    const findings = adviseOptimization(
      input({
        sessions: [
          session({
            name: 'cache lane',
            totalTokens: 1,
            cacheWriteTokens: 150_000,
            cacheReadTokens: 50_000,
          }),
        ],
      }),
    )
    expect(findings).toEqual([
      {
        id: 'cache-churn',
        severity: 'serious',
        title: 'A lane is re-writing its context cache',
        detail:
          '"cache lane" re-wrote 75% of its cached context instead of reading it back. Two known causes: a ' +
          'pi-claude-cli older than 0.7.0 restarts the CLI on every turn and every tool call, ' +
          'and long gaps between turns let the provider’s prompt cache expire.',
        settingsTab: 'claude-provider',
      },
    ])
  })

  it.each([
    [false, false, false, 'headroom-off', 'tip'],
    [false, false, true, 'headroom-off', 'tip'],
    [false, true, false, 'headroom-off', 'tip'],
    [false, true, true, 'headroom-off', 'tip'],
    [true, false, false, 'headroom-missing', 'warning'],
    [true, false, true, 'headroom-missing', 'warning'],
    [true, true, false, 'headroom-down', 'warning'],
    [true, true, true, undefined, undefined],
  ] as const)(
    'headroom enabled %s installed %s proxy %s selects %s',
    (enabled, installed, proxyRunning, id, severity) => {
      const findings = adviseOptimization(input({ headroom: { enabled, installed, proxyRunning } }))
      expect(
        findings.map((finding) => [finding.id, finding.severity, finding.settingsTab]),
      ).toEqual(id ? [[id, severity, 'optimization']] : [])
    },
  )

  it.each([2, 3])('MCP threshold at %i direct servers', (mcpServerCount) => {
    const findings = adviseOptimization(input({ mcpServerCount }))
    expect(findings).toEqual(
      mcpServerCount < 3
        ? []
        : [
            {
              id: 'mcp-weight',
              severity: 'tip',
              title: '3 MCP servers expose tools directly',
              detail:
                'A direct tool adds its schema to every request. Put the ones this project does ' +
                'not call on every turn back on codemode, where scripts can return only the ' +
                'fields they need: a 5-field projection measured 14× smaller, then compressed ' +
                'a further 44%.',
              settingsTab: 'connectors',
            },
          ],
    )
  })

  it.each([4_999_999, 5_000_000])('long-session threshold at %i tokens', (totalTokens) => {
    const findings = adviseOptimization(
      input({ sessions: [session({ name: 'deep', totalTokens })] }),
    )
    expect(findings).toEqual(
      totalTokens < 5_000_000
        ? []
        : [
            {
              id: 'long-session',
              severity: 'tip',
              title: 'A lane is carrying a very long history',
              detail:
                '"deep" has consumed 5M tokens. Forking from a bookmark starts a lane that keeps the conclusions and drops ' +
                'the transcript.',
            },
          ],
    )
  })

  it('chooses the largest write count and token total, preserving first lane on ties', () => {
    const findings = adviseOptimization(
      input({
        sessions: [
          session({ name: 'higher ratio', cacheWriteTokens: 200_000, totalTokens: 5_000_000 }),
          session({
            name: 'first worst',
            cacheWriteTokens: 300_000,
            cacheReadTokens: 100_000,
            totalTokens: 6_600_000,
          }),
          session({
            name: 'tied worst',
            cacheWriteTokens: 300_000,
            cacheReadTokens: 100_000,
            totalTokens: 6_600_000,
          }),
        ],
      }),
    )
    expect(findings.map((finding) => finding.id)).toEqual(['cache-churn', 'long-session'])
    expect(findings[0]!.detail).toContain('"first worst" re-wrote 75%')
    expect(findings[1]!.detail).toContain('"first worst" has consumed 7M')
  })

  it.each([false, true])('sorts severity stably with headroom enabled %s', (enabled) => {
    const findings = adviseOptimization(
      input({
        headroom: { enabled, installed: false, proxyRunning: false },
        mcpServerCount: 3,
        sessions: [session({ totalTokens: 5_000_000, cacheWriteTokens: 200_000 })],
      }),
    )
    expect(findings.map((finding) => [finding.id, finding.severity])).toEqual([
      ['cache-churn', 'serious'],
      enabled ? ['headroom-missing', 'warning'] : ['headroom-off', 'tip'],
      ['mcp-weight', 'tip'],
      ['long-session', 'tip'],
    ])
  })

  it.each([
    [{ name: 'named', firstUserText: 'prompt' }, 'named'],
    [{ firstUserText: 'prompt' }, 'prompt'],
    [{}, 'untitled lane'],
    [{ name: '', firstUserText: 'prompt' }, ''],
    [{ name: 'x'.repeat(48) }, 'x'.repeat(48)],
    [{ name: 'x'.repeat(49) }, `${'x'.repeat(48)}…`],
    [{ firstUserText: 'y'.repeat(49) }, `${'y'.repeat(48)}…`],
  ])('labels lanes with %j as %s', (overrides, label) => {
    const findings = adviseOptimization(
      input({
        sessions: [session({ ...overrides, cacheWriteTokens: 200_000, totalTokens: 5_000_000 })],
      }),
    )
    expect(findings[0]!.detail).toContain(`"${label}" re-wrote`)
    expect(findings[1]!.detail).toContain(`"${label}" has consumed`)
  })

  it('only returns advice, without mutating frozen inputs or sharing results across calls', () => {
    const value = input({
      headroom: { enabled: false, installed: false, proxyRunning: false },
      mcpServerCount: 3,
      sessions: [
        session({ name: 'smaller', totalTokens: 5_000_000, cacheWriteTokens: 200_000 }),
        session({ name: 'larger', totalTokens: 6_000_000, cacheWriteTokens: 300_000 }),
      ],
    })
    value.sessions.forEach(Object.freeze)
    Object.freeze(value.sessions)
    Object.freeze(value.headroom)
    Object.freeze(value)
    const before = structuredClone(value)
    const first = adviseOptimization(value)
    const second = adviseOptimization(value)
    expect(value).toEqual(before)
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
    first[0]!.detail = 'changed by caller'
    expect(adviseOptimization(value)).toEqual(second)
  })
})
