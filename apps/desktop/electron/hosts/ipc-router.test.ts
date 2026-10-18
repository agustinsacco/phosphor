import { beforeEach, expect, it, vi } from 'vitest'
import type { HostIpcRuntime } from './ipc-router'
import { createHostIpcRouter } from './ipc-router'
import { createHostConnection } from './connection'
import { routeRemoteRead } from './read-features'
import { routeRemoteWrite } from './write-features'
import {
  createArtifactHost,
  remoteArtifactRead,
  remoteArtifactListings,
  remoteSessionArtifacts,
} from './artifacts'
import { artifactLibrary } from '../artifacts/artifact-sync'

const state = vi.hoisted(() => ({
  machineLane: vi.fn(),
}))
vi.mock('./machine-reads', () => ({ machineReads: () => ({ lane: state.machineLane }) }))
vi.mock('./read-features', () => ({ routeRemoteRead: vi.fn(() => null) }))
vi.mock('./write-features', () => ({ routeRemoteWrite: vi.fn(() => null) }))
vi.mock('./artifacts', () => ({
  createArtifactHost: vi.fn((hostId: string, label: string) => ({ hostId, label })),
  remoteArtifactRead: vi.fn(async () => null),
  remoteArtifactListings: vi.fn(async () => []),
  remoteSessionArtifacts: vi.fn(async () => []),
}))
vi.mock('../artifacts/artifact-sync', () => ({ artifactLibrary: { list: vi.fn(async () => []) } }))

function fixture() {
  const runtime = {
    manager: {
      snapshot: vi.fn<HostIpcRuntime['manager']['snapshot']>(() => ({})),
      connection: vi.fn<HostIpcRuntime['manager']['connection']>(),
      label: vi.fn((id: string) => `label:${id}`),
    },
    remote: { readLane: vi.fn<HostIpcRuntime['remote']['readLane']>(() => null) },
    terminals: { route: vi.fn<HostIpcRuntime['terminals']['route']>(() => null) },
    routines: { route: vi.fn<HostIpcRuntime['routines']['route']>(() => null) },
  } satisfies HostIpcRuntime
  return { runtime, route: createHostIpcRouter(runtime) }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(routeRemoteRead).mockReset().mockReturnValue(null)
  vi.mocked(routeRemoteWrite).mockReset().mockReturnValue(null)
})
it('routes terminal before routine before all resource routes, retaining sender and arguments', () => {
  const { runtime, route } = fixture()
  const terminal = { result: Promise.resolve('terminal') }
  const routine = { result: Promise.resolve('routine') }
  runtime.terminals.route.mockReturnValueOnce(terminal)
  runtime.routines.route.mockReturnValue(routine)
  const args = ['host:h/machine']
  expect(route(7, 'skills:list', args)).toBe(terminal)
  expect(runtime.terminals.route).toHaveBeenCalledWith(7, 'skills:list', args)
  expect(runtime.routines.route).not.toHaveBeenCalled()
  expect(route(7, 'skills:list', args)).toBe(routine)
  expect(runtime.routines.route).toHaveBeenCalledWith('skills:list', args)
  expect(routeRemoteRead).not.toHaveBeenCalled()
  expect(routeRemoteWrite).not.toHaveBeenCalled()
})
it('machine keys precede artifacts and never fall through even when their read route is null', () => {
  const { runtime, route } = fixture()
  const lane = { workspacePath: 'host:h/machine', call: vi.fn() }
  state.machineLane.mockReturnValue(lane)
  vi.mocked(routeRemoteRead).mockImplementation((_channel, _args, resolve) => {
    expect(resolve('ignored')).toBe(lane)
    return null
  })
  expect(route(7, 'artifacts:read', ['host:h/machine/artifact:x'])).toBeNull()
  expect(state.machineLane).toHaveBeenCalledExactlyOnceWith('h')
  expect(remoteArtifactRead).not.toHaveBeenCalled()
  expect(routeRemoteWrite).not.toHaveBeenCalled()
  expect(runtime.remote.readLane).not.toHaveBeenCalled()
})
it('artifact routes precede workspace writes and reads and require an owned session handle', () => {
  const { runtime, route } = fixture()
  expect(() => route(7, 'artifacts:forSession', ['remote-handle'])).toThrow(
    'Not available on remote lanes yet.',
  )
  const lane = { workspacePath: 'host:h/lane:l', call: vi.fn(), write: vi.fn() }
  runtime.remote.readLane.mockReturnValue(lane)
  expect(route(7, 'artifacts:forSession', ['remote-handle'])).toEqual({
    result: expect.any(Promise),
  })
  expect(runtime.remote.readLane).toHaveBeenLastCalledWith(7, 'remote-handle')
  expect(remoteSessionArtifacts).toHaveBeenCalledWith(lane)
  expect(route(7, 'artifacts:read', ['host:h/lane:l/artifact:a'])).toEqual({
    result: expect.any(Promise),
  })
  expect(remoteArtifactRead).toHaveBeenCalledWith('host:h/lane:l/artifact:a', [])
  expect(routeRemoteWrite).not.toHaveBeenCalled()
  expect(routeRemoteRead).not.toHaveBeenCalled()
})
it('workspace writes precede reads and both resolve through the sender-owned lane; unrelated calls return null', () => {
  const { runtime, route } = fixture()
  const result = { result: Promise.resolve('write') }
  const key = 'host:h/lane:l'
  vi.mocked(routeRemoteWrite).mockImplementation((_channel, _args, resolve) => {
    expect(resolve(key)).toBeNull()
    return result
  })
  expect(route(7, 'fs:writeFile', [key])).toBe(result)
  expect(runtime.remote.readLane).toHaveBeenLastCalledWith(7, key)
  expect(routeRemoteRead).not.toHaveBeenCalled()
  vi.mocked(routeRemoteWrite).mockReturnValue(null)
  vi.mocked(routeRemoteRead).mockImplementation((_channel, _args, resolve) => {
    expect(resolve(key)).toBeNull()
    return result
  })
  expect(route(8, 'fs:listFiles', [key])).toBe(result)
  expect(runtime.remote.readLane).toHaveBeenLastCalledWith(8, key)
  vi.mocked(routeRemoteRead).mockReturnValue(null)
  expect(route(7, 'app:about', [])).toBeNull()
})
it('projects only ready artifact-capable connected hosts and keeps the live connection resolver', async () => {
  const { runtime, route } = fixture()
  const connection = createHostConnection({
    hostId: 'h',
    endpoint: null,
    socket: vi.fn(),
    grant: vi.fn(),
    clearGrant: vi.fn(),
    changed: vi.fn(),
  })
  runtime.manager.connection.mockImplementation((id) => (id === 'missing' ? undefined : connection))
  const view = {
    ...connection.snapshot(),
    state: 'ready' as const,
    capabilities: ['artifacts.read' as const],
    lanes: [],
  }
  runtime.manager.snapshot.mockReturnValue({
    h: view,
    missing: view,
    connecting: { ...view, state: 'connecting' },
    incapable: { ...view, capabilities: [] },
  })
  const result = route(7, 'artifacts:list', [['/local']])
  expect(await result?.result).toEqual([])
  expect(createArtifactHost).toHaveBeenCalledExactlyOnceWith(
    'h',
    'label:h',
    connection,
    expect.any(Function),
  )
  const current = vi.mocked(createArtifactHost).mock.calls[0]![3]
  expect(current()).toBe(connection)
  runtime.manager.connection.mockReturnValue(undefined)
  expect(current()).toBeUndefined()
  expect(remoteArtifactListings).toHaveBeenCalledWith([{ hostId: 'h', label: 'label:h' }])
  expect(artifactLibrary.list).toHaveBeenCalledWith(['/local'])
})
it('rejects malformed library keys before any local or remote side effect', () => {
  const { route } = fixture()
  for (const input of [null, ['host:h'], ['remote-handle'], [3], Array(2001).fill('/local')])
    expect(() => route(7, 'artifacts:list', [input])).toThrow('Not available on remote lanes yet.')
  expect(artifactLibrary.list).not.toHaveBeenCalled()
  expect(remoteArtifactListings).not.toHaveBeenCalled()
})
