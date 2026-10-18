import { beforeEach, expect, it, vi } from 'vitest'
import type { HostConnectionSnapshot } from './connection'
import type { HostFrame } from '@phosphor/shared/host-protocol'
import { repositoryReads } from './repository-reads'
const repositoryId = '1234567890abcdef'
let view: HostConnectionSnapshot
let generation = 1
const call = vi.fn<(...args: unknown[]) => Promise<Extract<HostFrame, { type: 'result' }>>>()
const c = {
  snapshot: () => view,
  incarnation: () => ({ generation, runtimeEpoch: '0000000000000001' }),
  call,
}
let connected: typeof c | undefined
const reads = repositoryReads(() => connected)
beforeEach(() => {
  connected = c
  generation = 1
  view = {
    connectionToken: 'test',
    state: 'ready',
    capabilities: ['workspaces.read'],
    lanes: [],
    repositories: [{ id: repositoryId, name: 'repo', path: '/not-used' }],
  }
  call
    .mockReset()
    .mockResolvedValue({ type: 'result', id: 'read', ok: true, data: { files: ['README.md'] } })
})
it('uses repository scope and parses paths from an untrusted reply', async () => {
  expect(await reads.list('host', repositoryId)).toEqual(['README.md'])
  expect(call).toHaveBeenCalledWith('files.list', { repositoryId })
  call.mockResolvedValueOnce({
    type: 'result',
    id: 'read',
    ok: true,
    data: { files: ['/private/path'] },
  })
  await expect(reads.list('host', repositoryId)).rejects.toThrow('Not available')
  await expect(reads.read('host', repositoryId, '../escape')).rejects.toThrow('Not available')
})
it.each(['capability', 'connection', 'generation', 'repository', 'readiness'] as const)(
  'rechecks %s after awaiting',
  async (change) => {
    call.mockImplementation(async () => {
      if (change === 'capability') view.capabilities = []
      if (change === 'connection') connected = { ...c }
      if (change === 'generation') generation++
      if (change === 'repository') view.repositories = []
      if (change === 'readiness') view.state = 'down'
      return { type: 'result', id: 'read', ok: true, data: { files: [] } }
    })
    await expect(reads.list('host', repositoryId)).rejects.toThrow('Not available')
  },
)
it('refuses unavailable and unconfigured machines before sending', async () => {
  for (const change of [
    () => {
      view.state = 'down'
    },
    () => {
      view.state = 'ready'
      view.capabilities = []
    },
    () => {
      view.capabilities = ['workspaces.read']
      view.repositories = []
    },
    () => {
      connected = undefined
    },
  ]) {
    change()
    await expect(reads.list('host', repositoryId)).rejects.toThrow('Not available')
  }
  expect(call).not.toHaveBeenCalled()
})
