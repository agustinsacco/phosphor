import { beforeEach, expect, it, vi } from 'vitest'
import { useRemoteLanesStore } from './remoteLanes'
import {
  useMachineCataloguesStore,
  machineCatalogueKey,
  EMPTY_MACHINE_CATALOGUE,
} from './machineCatalogues'
import { useSkillsStore } from './skills'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'

const invoke = vi.fn()
const models = [{ id: 'm', name: 'Remote model', provider: 'p', reasoning: false }]
beforeEach(() => {
  vi.stubGlobal('window', { phosphor: { invoke } })
  const hosts = structuredClone(mockRemoteHosts)
  const host = hosts[MOCK_HOST_ID]
  if (host) host.capabilities.push('skills.read')
  useRemoteLanesStore.setState({ hosts })
  useSkillsStore.setState({ byWorkspace: {} })
  useMachineCataloguesStore.setState({ catalogues: {} })
  invoke
    .mockReset()
    .mockImplementation(async (method) =>
      method === 'hosts:skills'
        ? { skills: [], probe: 'rpc', userRoot: 'opaque' }
        : method === 'hosts:models'
          ? models
          : [{ id: 'p', name: 'Provider', status: 'ready' }],
    )
})
it('loads sequential machine reads and never invokes local catalogues', async () => {
  await useMachineCataloguesStore.getState().load(MOCK_HOST_ID)
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
    'hosts:skills',
    'hosts:models',
    'hosts:providers',
  ])
  expect(catalogue().models).toEqual(models)
})
it('does not issue a read for a down or capability-less machine', async () => {
  const hosts = structuredClone(mockRemoteHosts)
  useRemoteLanesStore.setState({ hosts })
  await useMachineCataloguesStore.getState().load(MOCK_HOST_ID)
  expect(invoke).not.toHaveBeenCalled()
})
it('ignores a late reply when the Host restarts under a ready snapshot', async () => {
  let resolve: ((value: unknown) => void) | undefined
  invoke.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const epoch = (value: string) =>
    useRemoteLanesStore.setState((s) => ({
      hosts: {
        ...s.hosts,
        [MOCK_HOST_ID]: { ...s.hosts[MOCK_HOST_ID]!, cursor: { epoch: value, seq: 1 } },
      },
    }))
  epoch('first')
  const pending = useMachineCataloguesStore.getState().load(MOCK_HOST_ID)
  epoch('second')
  resolve?.({ skills: [], probe: 'rpc', userRoot: 'opaque' })
  await pending
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(catalogue().models).toEqual([])
})
it.each(['reconnect'] as const)('ignores a late reply after %s', async () => {
  let resolve: ((value: unknown) => void) | undefined
  invoke.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const pending = useMachineCataloguesStore.getState().load(MOCK_HOST_ID)
  {
    useRemoteLanesStore.setState((s) => ({
      hosts: { ...s.hosts, [MOCK_HOST_ID]: { ...s.hosts[MOCK_HOST_ID]!, state: 'reconnecting' } },
    }))
    useRemoteLanesStore.setState((s) => ({
      hosts: { ...s.hosts, [MOCK_HOST_ID]: { ...s.hosts[MOCK_HOST_ID]!, state: 'ready' } },
    }))
  }
  resolve?.({ skills: [], probe: 'rpc', userRoot: 'opaque' })
  await pending
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(catalogue().models).toEqual([])
  expect(useSkillsStore.getState().byWorkspace[`host:${MOCK_HOST_ID}/machine`]).toBeUndefined()
})

it.each(['hosts:models', 'hosts:providers'] as const)(
  'retains late %s when a consumer leaves',
  async (stage) => {
    let resolve: ((value: unknown) => void) | undefined
    invoke.mockImplementation(async (method) => {
      if (method === stage)
        return new Promise((done) => {
          resolve = done
        })
      return method === 'hosts:skills'
        ? { skills: [], probe: 'rpc', userRoot: 'opaque' }
        : method === 'hosts:models'
          ? models
          : [{ id: 'p', name: 'Provider', status: 'ready' }]
    })
    const pending = useMachineCataloguesStore.getState().load(MOCK_HOST_ID)
    await vi.waitFor(() => expect(resolve).toBeDefined())
    await useMachineCataloguesStore.getState().load(null)
    resolve?.(stage === 'hosts:models' ? models : [{ id: 'p', name: 'Provider', status: 'ready' }])
    await pending
    expect(catalogue().models).toEqual(models)
    expect(catalogue().providers).toEqual([{ id: 'p', name: 'Provider', status: 'ready' }])
    expect(invoke).toHaveBeenCalledTimes(3)
  },
)

it('accepts a delayed catalogue across unchanged periodic snapshots', async () => {
  let finish!: (value: unknown) => void
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = useMachineCataloguesStore.getState().load(MOCK_HOST_ID)
  for (let tick = 0; tick < 3; tick++)
    useRemoteLanesStore.setState({ hosts: structuredClone(useRemoteLanesStore.getState().hosts) })
  finish({ skills: [], probe: 'rpc', userRoot: 'opaque' })
  await pending
  expect(catalogue().models).toEqual(models)
  expect(useSkillsStore.getState().byWorkspace[`host:${MOCK_HOST_ID}/machine`]).toBeDefined()
})

it.each(['reply', 'failure'] as const)(
  'discards a late %s after a coalesced ready-to-ready reconnect',
  async (outcome) => {
    let finish!: (value: unknown) => void
    let fail!: (error: Error) => void
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finish = resolve
          fail = reject
        }),
    )
    const pending = useMachineCataloguesStore.getState().load(MOCK_HOST_ID)
    useRemoteLanesStore.setState((s) => ({
      hosts: {
        ...s.hosts,
        [MOCK_HOST_ID]: { ...s.hosts[MOCK_HOST_ID]!, connectionToken: 'reconnected' },
      },
    }))
    if (outcome === 'reply') finish({ skills: [], probe: 'rpc', userRoot: 'opaque' })
    else fail(new Error('Connection closed.'))
    await pending
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(catalogue().error).toBeNull()
    expect(useSkillsStore.getState().byWorkspace[`host:${MOCK_HOST_ID}/machine`]).toBeUndefined()
  },
)

function catalogue() {
  return (
    useMachineCataloguesStore.getState().catalogues[machineCatalogueKey(MOCK_HOST_ID)] ??
    EMPTY_MACHINE_CATALOGUE
  )
}
