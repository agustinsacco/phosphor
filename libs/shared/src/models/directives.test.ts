import { expect, expectTypeOf, it } from 'vitest'
import {
  AGENT_DIRECTIVE_KEYS,
  DEFAULT_AGENT_DIRECTIVES,
  normalizeAgentDirectives,
  type AgentDirectivePrefs,
} from './directives'

it('directives keeps every default flag', () => {
  expect(DEFAULT_AGENT_DIRECTIVES).toEqual({
    machineAwareness: true,
    worktreeGuard: true,
    laneCharter: true,
    subagentPolicy: true,
  })
  expect(Object.keys(DEFAULT_AGENT_DIRECTIVES)).toEqual([...AGENT_DIRECTIVE_KEYS])
  expectTypeOf<AgentDirectivePrefs>().toEqualTypeOf<{
    machineAwareness: boolean
    worktreeGuard: boolean
    laneCharter: boolean
    subagentPolicy: boolean
  }>()
})

it('completes stored prefs from the defaults and drops the retired free text', () => {
  expect(normalizeAgentDirectives({ laneCharter: false, custom: 'old text' })).toEqual({
    ...DEFAULT_AGENT_DIRECTIVES,
    laneCharter: false,
  })
  expect(normalizeAgentDirectives({ worktreeGuard: 'no' })).toEqual(DEFAULT_AGENT_DIRECTIVES)
  expect(normalizeAgentDirectives(null)).toEqual(DEFAULT_AGENT_DIRECTIVES)
})
