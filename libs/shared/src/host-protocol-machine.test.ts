import { describe, expect, it } from 'vitest'
import {
  isSkillFile,
  parseMachineParams,
  parseMachineModels,
  parseMachineProviders,
  parseMachineSkills,
  parseSkillReadResult,
} from './host-protocol-machine'
const model = { id: 'model', name: 'Model', provider: 'provider', reasoning: false }
describe('host-protocol-machine', () => {
  it('validates exact method params and UUIDs', () => {
    expect(
      parseMachineParams('skills.read', {
        name: 'skill',
        file: 'scripts/run.sh',
        laneId: '12345678-1234-4234-8234-123456789abc',
      }),
    ).not.toBeNull()
    for (const value of [
      null,
      [],
      { name: '../x' },
      { name: 'skill', laneId: 'x' },
      { name: 'skill', root: '/' },
      { name: 'a'.repeat(65) },
    ])
      expect(parseMachineParams('skills.read', value)).toBeNull()
    expect(parseMachineParams('unknown.method', {})).toBeNull()
    expect(parseMachineParams('machine.providers', {})).toEqual({})
    expect(isSkillFile('a'.repeat(1024))).toBe(true)
    expect(isSkillFile('a'.repeat(1025))).toBe(false)
    for (const value of ['', '/x', '../x', 'a/../x', '.git/config', 'a\0', 'a\\b', './a', 'a//b'])
      expect(isSkillFile(value)).toBe(false)
  })
  it('projects models and checks counts and metadata', () => {
    expect(
      parseMachineModels([
        { ...model, thinkingLevelMap: { high: 'budget', xhigh: null, max: 'maximum' } },
      ]),
    ).toEqual([{ ...model, thinkingLevelMap: { high: 'budget', xhigh: null, max: 'maximum' } }])
    expect(parseMachineModels([{ ...model, thinkingLevelMap: { extra: 'secret' } }])).toBeNull()
    expect(
      parseMachineModels([
        {
          ...model,
          auth: 'private',
          contextWindow: 200000,
          input: ['text', 'image'],
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, private: 'extra' },
        },
      ]),
    ).toEqual([
      {
        ...model,
        contextWindow: 200000,
        input: ['text', 'image'],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    ])
    expect(parseMachineModels(Array(1000).fill(model))).toHaveLength(1000)
    expect(parseMachineModels(Array(1001).fill(model))).toBeNull()
    for (const m of [
      {},
      { ...model, contextWindow: -1 },
      { ...model, maxTokens: NaN },
      { ...model, cost: {} },
      { ...model, input: ['audio'] },
    ])
      expect(parseMachineModels([m])).toBeNull()
  })
  it('projects provider readiness only and validates skills and read results', () => {
    const provider = { id: 'p', name: 'P', status: 'ready' }
    expect(
      parseMachineProviders([
        { ...provider, credentials: { token: 'private' }, reason: 'private' },
      ]),
    ).toEqual([provider])
    expect(parseMachineProviders([{ ...provider, status: 'invalid' }])).toBeNull()
    expect(parseMachineProviders(Array(65).fill(provider))).toBeNull()
    const skill = { name: 's', description: 'description', scope: 'user' }
    expect(parseMachineSkills(Array(500).fill(skill))).toHaveLength(500)
    expect(parseMachineSkills(Array(501).fill(skill))).toBeNull()
    expect(parseMachineSkills([{ ...skill, scope: 'temporary' }])).toBeNull()
    expect(parseSkillReadResult({ binary: true, size: 3 })).toEqual({ binary: true, size: 3 })
    expect(parseSkillReadResult({ binary: false, size: 1, content: 'x' })).not.toBeNull()
    for (const r of [
      { binary: false, size: 2097153, content: 'x' },
      { binary: true, size: -1 },
      { binary: false, size: 0 },
    ])
      expect(parseSkillReadResult(r)).toBeNull()
  })
})
