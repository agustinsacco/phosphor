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
it('reads PRs by opaque repository identity and rejects unsafe replies', async () => {
  const key = 'host:00000000-0000-4000-8000-000000000001/repo:' + repositoryId
  call.mockResolvedValue({
    type: 'result',
    id: 'pr',
    ok: true,
    data: {
      byBranch: {
        lane: { number: 42, title: 'PR', state: 'MERGED', url: 'https://github.com/a/b/pull/42' },
      },
      complete: true,
    },
  })
  expect(await reads.pullRequests(key)).toMatchObject({ byBranch: { lane: { state: 'MERGED' } } })
  expect(call).toHaveBeenCalledWith('github.prs', { repositoryId })
  call.mockResolvedValue({
    type: 'result',
    id: 'pr',
    ok: true,
    data: { byBranch: { lane: { url: 'file:///etc/passwd' } }, complete: true },
  })
  expect(await reads.pullRequests(key)).toBeNull()
  await expect(reads.pullRequests('/local/repo')).rejects.toThrow('Not available')
  call.mockImplementation(async () => {
    generation++
    return { type: 'result', id: 'pr', ok: true, data: { byBranch: {}, complete: true } }
  })
  await expect(reads.pullRequests(key)).rejects.toThrow('Not available')
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
it('names a too-large or failed repository list with fixed text, never Host text', async () => {
  const failed = (code: string) => ({
    type: 'result' as const,
    id: 'read',
    ok: false as const,
    error: { code, message: '/private detail' },
  })
  call.mockResolvedValueOnce(failed('too-large') as Extract<HostFrame, { type: 'result' }>)
  await expect(reads.list('host', repositoryId)).rejects.toThrow(
    new Error('Too many files to list: the Host stops at 20,000.'),
  )
  call.mockResolvedValueOnce(failed('internal') as Extract<HostFrame, { type: 'result' }>)
  await expect(reads.list('host', repositoryId)).rejects.toThrow(
    new Error("The Host couldn't list this folder."),
  )
  call.mockResolvedValueOnce(failed('bad-request') as Extract<HostFrame, { type: 'result' }>)
  await expect(reads.list('host', repositoryId)).rejects.toThrow(
    new Error('Not available on remote lanes yet.'),
  )
  call.mockResolvedValueOnce(failed('internal') as Extract<HostFrame, { type: 'result' }>)
  await expect(reads.read('host', repositoryId, 'README.md')).rejects.toThrow(
    new Error('Not available on remote lanes yet.'),
  )
})
