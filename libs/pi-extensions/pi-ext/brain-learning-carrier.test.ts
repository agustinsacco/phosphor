import { expect, it, vi } from 'vitest'
import { registerLearningCarrier, type LearningCarrierApi } from './brain-learning-carrier'
import type { LearningCarrierContext } from './brain-learning-carrier-operation'
import { carrierErrorUsage, carrierErrorMessage } from './brain-learning-carrier-files'
function carrier(branch: unknown[] = []) {
  const events = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  let command: Parameters<LearningCarrierApi['registerCommand']>[1] | undefined
  const loadSdk = vi.fn(),
    tools: string[] = []
  const ctx = { sessionManager: { getBranch: () => branch } } as LearningCarrierContext
  registerLearningCarrier(
    {
      on: (name, handler) => {
        events.set(name, handler)
      },
      appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }),
      getActiveTools: () => tools,
      getAllTools: () => tools,
      registerCommand: (_name, registered) => {
        command = registered
      },
    },
    '/synthetic/control.json',
    'job',
    'a'.repeat(64),
    loadSdk,
  )
  return { events, command: command!, ctx, branch, tools, loadSdk }
}
it('blocks ordinary input as handled and makes the prompt loop unreachable', () => {
  const c = carrier()
  c.events.get('session_start')!({}, c.ctx)
  expect(c.events.get('input')!({ text: 'continue work' }, c.ctx)).toEqual({ action: 'handled' })
  expect(() => c.events.get('before_agent_start')!({}, c.ctx)).toThrow('forbids')
  expect(c.loadSdk).not.toHaveBeenCalled()
})
it('authenticates nonce, operation and job ownership before any source/SDK/auth operation', async () => {
  const c = carrier()
  c.events.get('session_start')!({}, c.ctx)
  for (const args of [
    'b'.repeat(64) + ' prepare',
    'a'.repeat(64) + ' run extra',
    'a'.repeat(64) + ' arbitrary',
  ])
    await expect(c.command.handler(args, c.ctx)).rejects.toThrow('authentication')
  expect(c.loadSdk).not.toHaveBeenCalled()
  const foreign = carrier([
    { type: 'custom', customType: 'phosphor-brain-owner', data: { kind: 'brain', jobId: 'other' } },
  ])
  expect(() => foreign.events.get('session_start')!({}, foreign.ctx)).toThrow('ownership')
  expect(foreign.loadSdk).not.toHaveBeenCalled()
})
it('refuses adopting a source transcript or unexpected executors, including inactive registered tools', () => {
  const source = carrier([{ type: 'message', message: { role: 'assistant', content: 'original' } }])
  expect(() => source.events.get('session_start')!({}, source.ctx)).toThrow()
  const tools = carrier()
  tools.tools.push('unexpected')
  expect(() => tools.events.get('session_start')!({}, tools.ctx)).toThrow('executable tools')
})
it('serializes only the safe known-response learningUsage and constant errors, not arbitrary credentials/config fields', () => {
  const error = Object.assign(new Error('provider secret=config-value'), {
    usage: { input: 999999 },
    apiKey: 'synthetic-secret',
    learningUsage: {
      input: 3,
      output: 2,
      cacheRead: null,
      cacheWrite: 0,
      reasoning: -2,
      token: 'synthetic-secret',
    },
  })
  expect(carrierErrorUsage(error)).toEqual({
    input: 3,
    output: 2,
    cacheRead: null,
    cacheWrite: 0,
    reasoning: null,
  })
  expect(
    JSON.stringify({ error: carrierErrorMessage(error), usage: carrierErrorUsage(error) }),
  ).not.toMatch(/synthetic-secret|config-value|999999/)
  expect(carrierErrorUsage({ usage: { input: 999999 } })).toBeUndefined()
})
it('rechecks transcript ownership for each authenticated operation, not only startup', async () => {
  const c = carrier()
  c.events.get('session_start')!({}, c.ctx)
  c.branch.splice(0, c.branch.length, {
    type: 'custom',
    customType: 'phosphor-brain-owner',
    data: { kind: 'brain', jobId: 'replaced' },
  })
  await expect(c.command.handler('a'.repeat(64) + ' prepare', c.ctx)).rejects.toThrow('ownership')
  expect(c.loadSdk).not.toHaveBeenCalled()
})
