import { describe, expect, it } from 'vitest'
import { AGENT_POLICY_DEFAULT, OP_CLASSES, OP_SCOPES, OP_TIERS, parseAgentPolicy } from '../ops'

describe('catalog type lists', () => {
  it('keeps tiers, scopes and classes exactly', () => {
    expect(OP_TIERS).toStrictEqual([
      'read',
      'lane',
      'create',
      'configure',
      'persistence',
      'destructive',
      'never',
    ])
    expect(OP_SCOPES).toStrictEqual(['self', 'other-lane', 'machine'])
    expect(OP_CLASSES).toStrictEqual(['control', 'service'])
  })
})

describe('parseAgentPolicy', () => {
  it('defaults to everything allowed with the stated limits', () => {
    expect(AGENT_POLICY_DEFAULT).toStrictEqual({
      version: 1,
      agentControl: 'all',
      machineOps: 'all',
      limits: { lanesPer10Min: 10, lineageDepth: 2, opsPerMinute: 120 },
    })
    expect(parseAgentPolicy(AGENT_POLICY_DEFAULT)).toStrictEqual(AGENT_POLICY_DEFAULT)
  })

  it('reads tier and op overrides', () => {
    const policy = {
      version: 1,
      agentControl: 'read',
      machineOps: 'off',
      tiers: { destructive: 'deny', configure: 'ask' },
      ops: { 'lane.create': 'ask' },
      limits: { opsPerMinute: 30 },
    }
    expect(parseAgentPolicy({ ...policy, extra: true })).toStrictEqual(policy)
  })

  it('refuses the never tier, unknown ops and decisions, and unbounded limits', () => {
    const base = { version: 1, agentControl: 'all', machineOps: 'all' }
    for (const bad of [
      { tiers: { never: 'allow' } },
      { tiers: { read: 'maybe' } },
      { ops: { 'Lane.create': 'ask' } },
      { limits: { opsPerMinute: -1 } },
      { limits: { lineageDepth: 10_001 } },
      { agentControl: 'some' },
      { version: 2 },
    ])
      expect(parseAgentPolicy({ ...base, ...bad }), JSON.stringify(bad)).toBeNull()
  })
})
