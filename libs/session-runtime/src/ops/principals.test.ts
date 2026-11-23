import { describe, expect, it } from 'vitest'
import { agent, local, machine, surface } from './__fixtures__/dispatcher-harness'
import { askingLane, confirmOrigin, governedAs, principalKey } from './principals'

const actor = { actor: { kind: 'agent' as const, lane: 'host:h/lane:l', title: 'Fix CI' } }

describe('principals', () => {
  it('keys each principal by kind and id', () => {
    expect([surface(), agent(), machine(), local()].map(principalKey)).toEqual([
      'surface:c1',
      'agent:local/session:s1',
      'machine:m-stark',
      'local:cli1',
    ])
  })

  it('governs a surface with an actor as an agent, and nothing else as a surface', () => {
    expect(governedAs(surface(), {})).toBe('surface')
    expect(governedAs(surface(), actor)).toBe('agent')
    expect(governedAs(machine(), actor)).toBe('machine')
    expect(governedAs(local(), actor)).toBe('local')
  })

  it('attributes the asking lane without trusting an actor over the agent’s own lane', () => {
    expect(askingLane(agent(), actor)).toBe('local/session:s1')
    expect(askingLane(local(), actor)).toBe('host:h/lane:l')
    expect(confirmOrigin(surface(), actor)).toEqual({
      kind: 'agent',
      label: 'Fix CI',
      lane: 'host:h/lane:l',
    })
    expect(confirmOrigin(machine(), {})).toEqual({
      kind: 'machine',
      label: 'stark',
      lane: 'host:x/lane:y',
    })
  })
})
