import { expect, it, vi } from 'vitest'
import { createBrowserResources } from './resources'
import type { BrowserHosts } from './hosts'
import type { RemoteLanes } from '@phosphor/host-client/remote-lanes'
import { randomUUID } from 'node:crypto'
import { newRoutine } from '@phosphor/shared/routines'

function setup() {
  const host = randomUUID(),
    other = randomUUID(),
    id = randomUUID(),
    repository = '0123456789abcdef'
  const { workspacePath: _path, ...defaults } = newRoutine('fixture')
  const row = {
    ...defaults,
    name: 'Fixture routine',
    instructions: 'Synthetic test',
    provider: 'test',
    model: 'test',
    repositoryId: repository,
    id,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    nextAt: null,
    archived: false,
  }
  const view = {
    state: 'ready',
    connectionToken: 'first',
    capabilities: ['routines', 'sessions.control', 'artifacts.read'],
    repositories: [{ id: repository, name: 'Fixture', path: '/fixture' }],
    lanes: [],
  }
  const call = vi.fn(async (method: string) => ({
    type: 'result',
    id: randomUUID(),
    ok: true,
    data: method === 'routines.list' ? [row] : [],
  }))
  const connection = { snapshot: () => view, call, send: vi.fn() }
  const snapshots: Record<string, unknown> = { [host]: view, [other]: { ...view, state: 'down' } }
  const manager = {
    directoryReady: () => true,
    snapshot: () => snapshots,
    label: () => 'Fixture',
    connection: (value: string) => (value === host ? connection : undefined),
  }
  const resources = createBrowserResources(
    manager as unknown as BrowserHosts,
    { readLane: () => null } as unknown as RemoteLanes,
  )
  return { resources, host, other, id, call, snapshots }
}
it('aggregates remote routines only, marks partial availability, and exposes machine choices', async () => {
  const s = setup()
  const value = await s.resources.routine('routines:list', [])
  expect(value).toMatchObject({
    routines: [{ id: `host:${s.host}/${s.id}` }],
    runs: [],
    background: false,
    error: expect.stringContaining('unavailable'),
    machines: expect.any(Array),
  })
  expect(s.call).toHaveBeenCalledWith('routines.list', {})
  expect(() => s.resources.routine('routines:save', [{ workspacePath: '/local' }])).toThrow(
    'Local routines',
  )
})
it('does not turn unavailable artifact hosts into an apparently complete empty library', async () => {
  const s = setup()
  await expect(s.resources.artifacts()).rejects.toThrow('incomplete')
  delete s.snapshots[s.other]
  expect(await s.resources.artifacts()).toEqual([])
})
it('reads an explicitly scoped artifact without depending on an unrelated offline host', async () => {
  const s = setup()
  expect(
    await s.resources.artifact(`host:${s.host}/lane:${randomUUID()}/artifact:fixture`),
  ).toBeNull()
  expect(() => s.resources.artifact('/local/artifact')).toThrow('Invalid artifact')
})
it('refuses local skills and malformed machine keys before remote dispatch', async () => {
  const s = setup()
  expect(() => s.resources.read('skills:list', [])).toThrow()
  expect(() => s.resources.read('skills:list', ['host:invalid/machine'])).toThrow()
  expect(s.call).not.toHaveBeenCalled()
})
