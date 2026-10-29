import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { IPC_WEB } from '@phosphor/shared/ipc-web'
import type { RemoteLanes } from '@phosphor/host-client/remote-lanes'
import { createBrowserHandlers } from './handlers'
import { createBrowserResources } from './resources'
import type { BrowserHosts } from './hosts'

const FOLDER_CHANNELS = [
  'hosts:listFolders',
  'hosts:createFolder',
  'hosts:addRepository',
  'hosts:removeRepository',
  'hosts:orderRepositories',
] as const
const repositoryId = '0123456789abcdef'

/* Desktop's folder dialog, on the same Host connection the browser already holds. */
function setup() {
  const host = randomUUID()
  const view = {
    state: 'ready',
    connectionToken: 'first',
    capabilities: ['sessions.read', 'sessions.control', 'workspaces.write'],
    repositories: [],
    lanes: [] as { laneId: string; control: { fence: number } }[],
  }
  const listing = {
    path: 'Projects',
    truncated: false,
    entries: [{ name: 'app', isRepository: true, configured: false }],
  }
  const call = vi.fn(async () => ({ type: 'result', id: randomUUID(), ok: true, data: listing }))
  const send = vi.fn(async (op: { type: string }) => ({
    requestId: randomUUID(),
    status: 'done',
    data:
      op.type === 'host.repositories.add'
        ? { id: repositoryId, path: '/home/u/x' }
        : op.type === 'lane.delete'
          ? { branchKept: true }
          : null,
  }))
  const connection = {
    snapshot: () => view,
    incarnation: () => ({ generation: 1, runtimeEpoch: '0000000000000001' }),
    call,
    send,
  }
  const hosts = {
    connection: (id: string) => (id === host ? connection : undefined),
    snapshot: () => ({ [host]: view }),
    label: () => 'Studio',
    directoryReady: () => true,
  }
  const resources = createBrowserResources(
    hosts as unknown as BrowserHosts,
    { readLane: () => null } as unknown as RemoteLanes,
  )
  const proxy = new Proxy({}, { get: () => () => undefined })
  const handlers = createBrowserHandlers({
    ...{ control: proxy, hosts: proxy, lanes: proxy, prefs: proxy, drafts: proxy },
    resources,
    window: () => proxy,
    openExternal: () => {},
    broadcastLogout: () => {},
    machinesChanged: () => {},
  } as never) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  return { handlers, host, view, listing, call, send }
}

it('admits browsing, creating, adding, removing and ordering Host folders in the browser', () => {
  for (const channel of FOLDER_CHANNELS) expect(IPC_WEB[channel].kind).toBe('remote-supported')
})

it('lists, creates and adds a folder over the Host connection', async () => {
  const s = setup()
  await expect(s.handlers['hosts:listFolders']!(s.host, 'Projects', false)).resolves.toEqual(
    s.listing,
  )
  expect(s.call).toHaveBeenCalledWith('machine.folders.list', { path: 'Projects' })
  await s.handlers['hosts:createFolder']!(s.host, 'Projects/new-app')
  expect(s.send).toHaveBeenLastCalledWith(
    { type: 'host.repositories.createFolder', path: 'Projects/new-app' },
    undefined,
    undefined,
  )
  await expect(s.handlers['hosts:addRepository']!(s.host, 'Projects/new-app')).resolves.toEqual({
    repositoryId,
  })
  expect(s.send).toHaveBeenLastCalledWith(
    { type: 'host.repositories.add', path: 'Projects/new-app' },
    undefined,
    undefined,
  )
})

it('removes and orders folders over the Host connection, as Desktop does', async () => {
  const s = setup()
  await s.handlers['hosts:removeRepository']!(s.host, repositoryId)
  expect(s.send).toHaveBeenLastCalledWith(
    { type: 'host.repositories.remove', repositoryId },
    undefined,
    undefined,
  )
  const other = 'fedcba9876543210'
  await s.handlers['hosts:orderRepositories']!(s.host, [other, repositoryId])
  expect(s.send).toHaveBeenLastCalledWith(
    { type: 'host.repositories.order', repositoryIds: [other, repositoryId] },
    undefined,
    undefined,
  )
})

it('sends nothing while the Host is away or cannot write workspaces', async () => {
  const s = setup()
  s.view.state = 'reconnecting'
  await expect(s.handlers['hosts:listFolders']!(s.host, '', false)).rejects.toThrow()
  s.view.state = 'ready'
  s.view.capabilities = ['sessions.read', 'sessions.control']
  await expect(s.handlers['hosts:addRepository']!(s.host, 'Projects')).rejects.toThrow()
  await expect(s.handlers['hosts:listFolders']!(randomUUID(), '', false)).rejects.toThrow()
  expect(s.call).not.toHaveBeenCalled()
  expect(s.send).not.toHaveBeenCalled()
})

it('deletes a lane over the Host connection with its control fence, as Desktop does', async () => {
  const s = setup()
  expect(IPC_WEB['hosts:deleteLane'].kind).toBe('remote-supported')
  expect(typeof s.handlers['hosts:deleteLane']).toBe('function')
  const laneId = randomUUID()
  s.view.lanes.push({ laneId, control: { fence: 3 } })
  const options = { removeWorktree: true, removeBranch: false }
  await expect(s.handlers['hosts:deleteLane']!(s.host, laneId, options)).resolves.toEqual({
    branchKept: true,
  })
  expect(s.send).toHaveBeenLastCalledWith({ type: 'lane.delete', laneId, ...options }, laneId, 3)
  // The Host admits lane.delete only from the lane's controller; a refusal is not a success.
  s.send.mockResolvedValueOnce({
    requestId: randomUUID(),
    status: 'rejected',
    code: 'forbidden',
  } as never)
  await expect(s.handlers['hosts:deleteLane']!(s.host, laneId, options)).rejects.toThrow(
    'The remote change was not confirmed.',
  )
  await expect(s.handlers['hosts:deleteLane']!(s.host, randomUUID(), options)).rejects.toThrow()
})
