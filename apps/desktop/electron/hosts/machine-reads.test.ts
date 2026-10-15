import { beforeEach, expect, it, vi } from 'vitest'
import type { HostConnectionSnapshot } from './connection'
import type { HostFrame } from '@shared/host-protocol'
import { machineReads } from './machine-reads'

let view: HostConnectionSnapshot
let generation: number
const call = vi.fn<(...args: unknown[]) => Promise<Extract<HostFrame, { type: 'result' }>>>()
const c = {
  snapshot: () => view,
  incarnation: () => ({ generation, runtimeEpoch: '0000000000000001' }),
  call,
}
let connected: typeof c | undefined
const reads = machineReads(() => connected)
beforeEach(() => {
  view = {
    connectionToken: 'test-connection-1',
    state: 'ready',
    capabilities: ['skills.read'],
    lanes: [],
    repositories: [],
  }
  generation = 1
  connected = c
  call.mockReset().mockResolvedValue({
    type: 'result',
    id: 'catalogue',
    ok: true,
    data: { models: [{ id: 'm', name: 'Model', provider: 'p', reasoning: false }] },
  })
})
it('uses the machine allowlist and parsed models, never a local fallback', async () => {
  expect(await reads.models('host')).toEqual([
    { id: 'm', name: 'Model', provider: 'p', reasoning: false },
  ])
  expect(call).toHaveBeenCalledWith('machine.models', {})
  connected = undefined
  await expect(reads.models('missing')).rejects.toThrow('Not available')
})
it('gates machine reads on current readiness and capability', async () => {
  for (const state of ['down', 'reconnecting', 'ready'] as const) {
    view = { ...view, state, capabilities: state === 'ready' ? [] : ['skills.read'] }
    await expect(reads.models('host')).rejects.toThrow('Not available')
  }
  expect(call).not.toHaveBeenCalled()
})
it.each(['capability', 'connection', 'incarnation'] as const)(
  'refuses replies after %s changes during the read',
  async (change) => {
    call.mockImplementation(async () => {
      if (change === 'capability') view = { ...view, capabilities: [] }
      if (change === 'connection') connected = { ...c }
      if (change === 'incarnation') generation++
      return { type: 'result', id: 'catalogue', ok: true, data: { models: [] } }
    })
    await expect(reads.models('host')).rejects.toThrow('Not available')
  },
)
it('rejects invalid model/provider replies and strips Host metadata', async () => {
  call.mockResolvedValueOnce({
    type: 'result',
    id: 'catalogue',
    ok: true,
    data: { models: [{ id: 'bad' }] },
  })
  await expect(reads.models('host')).rejects.toThrow('Not available')
  call.mockResolvedValueOnce({
    type: 'result',
    id: 'catalogue',
    ok: true,
    data: { providers: [{ id: 'p', name: 'Provider', status: 'ready', path: '/private' }] },
  })
  expect(await reads.providers('host')).toEqual([{ id: 'p', name: 'Provider', status: 'ready' }])
  call.mockResolvedValueOnce({
    type: 'result',
    id: 'catalogue',
    ok: true,
    data: {
      skills: [{ name: 'safe-skill', description: 'Safe', scope: 'user', path: '/private' }],
    },
  })
  const skills = await reads.skills('host')
  expect(skills.skills[0]?.dir).toBe('host:host/machine/skill:safe-skill')
  expect(JSON.stringify(skills)).not.toContain('/private')
})
