import { describe, expect, it } from 'vitest'
import { AGENT_POLICY_DEFAULT, type AgentPolicy } from '@phosphor/shared/ops'
import { gateVerdict, policyDecision, stricterPolicy } from './policy'

const policy = (over: Partial<AgentPolicy> = {}): AgentPolicy => ({
  ...AGENT_POLICY_DEFAULT,
  ...over,
})

describe('policyDecision', () => {
  const decide = (
    over: Partial<AgentPolicy>,
    op: string,
    tier: 'lane' | 'destructive',
    scope: 'self' | 'other-lane' | 'machine' = 'machine',
  ) => policyDecision({ op, tier, scope, policy: policy(over) })

  it('allows every tier but destructive, which asks', () => {
    expect(decide({}, 'lane.rename', 'lane')).toBe('allow')
    expect(decide({}, 'archive.purge', 'destructive')).toBe('ask')
  })

  it('lets a tier entry only tighten', () => {
    expect(decide({ tiers: { lane: 'ask' } }, 'lane.rename', 'lane')).toBe('ask')
    expect(decide({ tiers: { destructive: 'allow' } }, 'archive.purge', 'destructive')).toBe('ask')
  })

  it('lets an op entry relax or tighten, except another lane’s ask', () => {
    expect(decide({ ops: { 'archive.purge': 'allow' } }, 'archive.purge', 'destructive')).toBe(
      'allow',
    )
    expect(decide({ ops: { 'lane.rename': 'deny' } }, 'lane.rename', 'lane')).toBe('deny')
    expect(
      decide({ ops: { 'lane.stop': 'allow' } }, 'lane.stop', 'destructive', 'other-lane'),
    ).toBe('ask')
    expect(decide({ ops: { 'lane.stop': 'deny' } }, 'lane.stop', 'destructive', 'other-lane')).toBe(
      'deny',
    )
  })
})

describe('gateVerdict', () => {
  const check = { op: 'x', tier: 'read' as const, scope: 'machine' as const, policy: policy() }

  it('never applies to surfaces', () => {
    expect(
      gateVerdict({ ...check, tier: 'never', surfaceOnly: true, governed: 'surface' }),
    ).toBeNull()
  })

  it('reads the kill switch for agents and local, machineOps for machines', () => {
    const off = policy({ agentControl: 'off' })
    expect(gateVerdict({ ...check, policy: off, governed: 'local' })).toMatchObject({
      code: 'policy',
    })
    expect(gateVerdict({ ...check, policy: off, governed: 'machine' })).toBeNull()
    expect(gateVerdict({ ...check, policy: off, governed: 'agent', class: 'service' })).toBeNull()
  })
})

describe('stricterPolicy', () => {
  it('takes the stricter of each key and drops one-sided relaxations', () => {
    const file = policy({
      agentControl: 'all',
      machineOps: 'off',
      tiers: { lane: 'ask' },
      ops: { 'archive.purge': 'allow', 'lane.rename': 'deny' },
      limits: { lanesPer10Min: 1000, opsPerMinute: 30 },
    })
    const snapshot = policy({ agentControl: 'read', tiers: { create: 'deny' }, limits: {} })
    expect(stricterPolicy(file, snapshot)).toEqual({
      version: 1,
      agentControl: 'read',
      machineOps: 'off',
      tiers: { lane: 'ask', create: 'deny' },
      ops: { 'lane.rename': 'deny' },
      limits: { lanesPer10Min: 10, lineageDepth: 2, opsPerMinute: 30 },
    })
  })

  it('keeps an op entry both sides share at its stricter value', () => {
    const a = policy({ ops: { 'archive.purge': 'allow' } })
    const b = policy({ ops: { 'archive.purge': 'ask' } })
    expect(stricterPolicy(a, b).ops).toEqual({ 'archive.purge': 'ask' })
  })
})
