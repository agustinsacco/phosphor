import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/models'
import { adviseOptimization, type AdvisorInput } from './advisor'

function meta(overrides: Partial<SessionMeta>): SessionMeta {
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
    cacheReadTokens: 3_000,
    cacheWriteTokens: 1_000,
    cost: 0.1,
    headroomSavedTokens: 0,
    entryCount: 6,
    branchCount: 0,
    mtimeMs: 1,
    lastActivityAt: '2026-09-08T01:00:00.000Z',
    ...overrides,
  }
}

const healthy: AdvisorInput['headroom'] = { enabled: true, installed: true, proxyRunning: true }

function input(overrides: Partial<AdvisorInput>): AdvisorInput {
  return { headroom: healthy, sessions: [], mcpServerCount: 0, ...overrides }
}

describe('adviseOptimization', () => {
  it('is quiet when everything is healthy and small', () => {
    expect(adviseOptimization(input({}))).toEqual([])
  })

  it('flags cache churn on the worst offender only, above the size floor', () => {
    const findings = adviseOptimization(
      input({
        sessions: [
          meta({ name: 'small churner', totalTokens: 50_000, cacheWriteTokens: 40_000 }),
          meta({ name: 'big churner', totalTokens: 400_000, cacheWriteTokens: 300_000 }),
          meta({ name: 'healthy lane', totalTokens: 400_000, cacheWriteTokens: 20_000 }),
        ],
      }),
    )
    const churn = findings.filter((f) => f.id === 'cache-churn')
    expect(churn).toHaveLength(1)
    expect(churn[0]!.severity).toBe('serious')
    expect(churn[0]!.detail).toContain('big churner')
    expect(churn[0]!.settingsTab).toBe('claude-provider')
  })

  it('grades the headroom gap by which step is missing', () => {
    const off = adviseOptimization(input({ headroom: { ...healthy, enabled: false } }))
    expect(off.map((f) => f.id)).toContain('headroom-off')
    expect(off.find((f) => f.id === 'headroom-off')!.severity).toBe('tip')

    const missing = adviseOptimization(input({ headroom: { ...healthy, installed: false } }))
    expect(missing.find((f) => f.id === 'headroom-missing')!.severity).toBe('warning')

    const down = adviseOptimization(input({ headroom: { ...healthy, proxyRunning: false } }))
    expect(down.find((f) => f.id === 'headroom-down')!.severity).toBe('warning')
  })

  it('tips on MCP schema weight at three connected servers, not below', () => {
    expect(adviseOptimization(input({ mcpServerCount: 2 }))).toEqual([])
    const findings = adviseOptimization(input({ mcpServerCount: 4 }))
    expect(findings.find((f) => f.id === 'mcp-weight')!.settingsTab).toBe('connectors')
  })

  it('sorts serious findings ahead of tips', () => {
    const findings = adviseOptimization(
      input({
        headroom: { ...healthy, enabled: false },
        sessions: [meta({ totalTokens: 400_000, cacheWriteTokens: 300_000 })],
        mcpServerCount: 5,
      }),
    )
    expect(findings[0]!.severity).toBe('serious')
    expect(findings.map((f) => f.severity)).toEqual(
      [...findings.map((f) => f.severity)].sort((a, b) => {
        const rank = { serious: 0, warning: 1, tip: 2 }
        return rank[a] - rank[b]
      }),
    )
  })

  it('suggests forking a very long session', () => {
    const findings = adviseOptimization(
      input({ sessions: [meta({ name: 'marathon', totalTokens: 6_000_000 })] }),
    )
    const drag = findings.find((f) => f.id === 'long-session')
    expect(drag).toBeDefined()
    expect(drag!.detail).toContain('marathon')
  })
})
