import { expect, expectTypeOf, it } from 'vitest'
import { DEFAULT_AGENT_DIRECTIVES, type AgentDirectivePrefs } from './directives'

it('directives keeps every default flag and free-text field', () => {
  expect(DEFAULT_AGENT_DIRECTIVES).toEqual({
    machineAwareness: true,
    worktreeGuard: true,
    laneCharter: true,
    subagentPolicy: true,
    custom: '',
  })
  expectTypeOf<AgentDirectivePrefs>().toEqualTypeOf<{
    machineAwareness: boolean
    worktreeGuard: boolean
    laneCharter: boolean
    subagentPolicy: boolean
    custom: string
  }>()
})
