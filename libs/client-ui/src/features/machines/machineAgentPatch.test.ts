import { expect, it } from 'vitest'
import {
  isPolicyPatch,
  nextAgentPatch,
  rebaseAgentFields,
  type AgentDraftFields,
} from './machineAgentPatch'
import { DEFAULT_AGENT_DIRECTIVES } from '@shared/models'

const base: AgentDraftFields = {
  model: JSON.stringify(['anthropic', 'claude-sonnet-4-5']),
  thinking: 'medium',
  budget: '200k',
  naming: true,
  behavior: { compaction: { enabled: true, reserveTokens: 16384 } },
  directives: DEFAULT_AGENT_DIRECTIVES,
}

it('sends only what differs from the Host, and nothing for an unchanged draft', () => {
  expect(nextAgentPatch(base, base)).toBeNull()
  expect(nextAgentPatch({ ...base, thinking: 'high' }, base)).toEqual({
    defaultThinkingLevel: 'high',
  })
  expect(
    nextAgentPatch(
      { ...base, behavior: { compaction: { enabled: false, reserveTokens: 16384 } } },
      base,
    ),
  ).toEqual({ compaction: { enabled: false, reserveTokens: 16384 } })
})

it('keeps pi settings and Host policy in separate patches, pi first', () => {
  const both = { ...base, model: JSON.stringify(['openai', 'gpt-5']), budget: '400k' }
  expect(nextAgentPatch(both, base)).toEqual({ defaultProvider: 'openai', defaultModel: 'gpt-5' })
  expect(nextAgentPatch(both, { ...base, model: both.model })).toEqual({ contextBudget: '400k' })
  expect(isPolicyPatch({ autoNameLanes: false })).toBe(true)
  expect(isPolicyPatch({ defaultThinkingLevel: 'low' })).toBe(false)
})

it('never sends an incomplete custom model', () => {
  expect(nextAgentPatch({ ...base, model: JSON.stringify(['openai', '']) }, base)).toBeNull()
  expect(nextAgentPatch({ ...base, model: '' }, base)).toBeNull()
})

it('adopts the Host’s values for what it acknowledged but keeps an edit made in flight', () => {
  const sent = { ...base, thinking: 'high' as const, budget: '' }
  const current = { ...sent, thinking: 'low' as const, naming: false }
  const acknowledged = { ...base, thinking: 'high' as const }
  const rebased = rebaseAgentFields(current, sent, acknowledged, {
    defaultThinkingLevel: 'high',
    contextBudget: '',
  })
  expect(rebased).toMatchObject({ thinking: 'low', budget: '200k', naming: false })
  expect(nextAgentPatch(rebased, acknowledged)).toEqual({ defaultThinkingLevel: 'low' })
})

it('rebases agent behavior one setting at a time', () => {
  const sent = { ...base, behavior: { ...base.behavior, retry: { enabled: false } } }
  const current = {
    ...sent,
    behavior: { ...sent.behavior, compaction: { enabled: false, reserveTokens: 16384 } },
  }
  const acknowledged = { ...base, behavior: { ...base.behavior, retry: { enabled: false } } }
  const rebased = rebaseAgentFields(current, sent, acknowledged, { retry: { enabled: false } })
  expect(rebased.behavior).toEqual(current.behavior)
  expect(nextAgentPatch(rebased, acknowledged)).toEqual({
    compaction: { enabled: false, reserveTokens: 16384 },
  })
})

it('saves directive switches as Host policy that needs no restart, and adopts them', () => {
  const directives = { ...DEFAULT_AGENT_DIRECTIVES, laneCharter: false }
  const patch = nextAgentPatch({ ...base, directives }, base)
  expect(patch).toEqual({ agentDirectives: directives })
  expect(isPolicyPatch(patch!)).toBe(false)
  const sent = { ...base, directives }
  expect(rebaseAgentFields(sent, sent, sent, patch!).directives).toEqual(directives)
})
