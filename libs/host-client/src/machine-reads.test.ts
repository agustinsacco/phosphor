import { beforeEach, expect, it, vi } from 'vitest'
import type { HostConnectionSnapshot } from './connection'
import type { HostFrame } from '@phosphor/shared/host-protocol'
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
it('reads Claude detail, falls back for old Hosts, and rejects malformed replies', async () => {
  for (const data of [
    { provider: 'missing', cli: 'missing', auth: 'unknown' },
    { provider: 'outdated', cli: 'ok', auth: 'signed-out' },
    { provider: 'ok', cli: 'ok', auth: 'ok' },
  ]) {
    call.mockResolvedValueOnce({ type: 'result', id: 'claude', ok: true, data })
    expect(await reads.claude('host')).toEqual(data)
  }
  expect(call).toHaveBeenCalledWith('machine.claude', {})
  call.mockResolvedValueOnce({
    type: 'result',
    id: 'claude',
    ok: false,
    error: { code: 'unsupported', message: 'Unknown method' },
  })
  expect(await reads.claude('host')).toBeNull()
  for (const data of [
    null,
    {},
    { provider: 'bad', cli: 'ok', auth: 'ok' },
    { provider: 'ok', cli: 'bad', auth: 'ok' },
    { provider: 'ok', cli: 'ok', auth: 'bad' },
    { provider: 'ok', cli: 'ok', auth: 'ok', extra: true },
  ]) {
    call.mockResolvedValueOnce({ type: 'result', id: 'claude', ok: true, data })
    expect(await reads.claude('host')).toBeNull()
  }
})
it('does not read Claude without capability or accept a late incarnation reply', async () => {
  view.capabilities = []
  expect(await reads.claude('host')).toBeNull()
  expect(call).not.toHaveBeenCalled()
  view.capabilities = ['skills.read']
  call.mockImplementationOnce(async () => {
    generation++
    return {
      type: 'result',
      id: 'claude',
      ok: true,
      data: { provider: 'ok', cli: 'ok', auth: 'ok' },
    }
  })
  expect(await reads.claude('host')).toBeNull()
})

it.each(['capability', 'connection', 'incarnation', 'state'] as const)(
  'discards late Claude detail after %s changes',
  async (change) => {
    call.mockImplementationOnce(async () => {
      if (change === 'capability') view.capabilities = []
      if (change === 'connection') connected = { ...c }
      if (change === 'incarnation') generation++
      if (change === 'state') view.state = 'down'
      return {
        type: 'result',
        id: 'claude',
        ok: true,
        data: { provider: 'ok', cli: 'ok', auth: 'ok' },
      }
    })
    expect(await reads.claude('host')).toBeNull()
  },
)

it('reads the lane plan usage, forwards a refresh, and falls back for old Hosts', async () => {
  const data = {
    ok: true,
    snapshot: {
      fetchedAt: 1,
      stale: false,
      windows: [
        { label: 'Current week (all models)', kind: 'weekly', percentUsed: 7, resetsAt: 2 },
      ],
    },
  }
  const lane = '00000000-0000-4000-8000-000000000098'
  call.mockResolvedValueOnce({ type: 'result', id: 'usage', ok: true, data })
  expect(await reads.claudeUsage('host', lane, true)).toEqual({
    ok: true,
    snapshot: { ...data.snapshot, contributing: null },
  })
  expect(call).toHaveBeenCalledWith('machine.claudeUsage', { laneId: lane, force: true })
  call.mockResolvedValueOnce({
    type: 'result',
    id: 'usage',
    ok: false,
    error: { code: 'unsupported', message: 'Unknown method' },
  })
  expect(await reads.claudeUsage('host')).toBeNull()
  expect(call).toHaveBeenLastCalledWith('machine.claudeUsage', {})
  // A lane id the protocol would refuse never reaches the Host.
  call.mockClear()
  expect(await reads.claudeUsage('host', '../lane')).toBeNull()
  expect(call).not.toHaveBeenCalled()
  view.capabilities = []
  expect(await reads.claudeUsage('host')).toBeNull()
})
