import { beforeEach, expect, it, vi } from 'vitest'
import { useRemoteLanesStore } from './remoteLanes'
import {
  useMachineCataloguesStore,
  machineCatalogueKey,
  recheckMachineCatalogue,
  EMPTY_MACHINE_CATALOGUE,
} from './machineCatalogues'
import { patchHostSettings } from '@/features/settings/machine/patchHostSettings'
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
          ? { models }
          : [{ id: 'p', name: 'Provider', status: 'ready' }],
    )
})
it('loads sequential machine reads and never invokes local catalogues', async () => {
  await useMachineCataloguesStore.getState().load(MOCK_HOST_ID)
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['hosts:models', 'hosts:providers'])
  expect(catalogue().models).toEqual(models)
  expect(catalogue().defaults).toBeUndefined()
})
it('keeps the Host pi’s defaults with its catalogue and drops a malformed one', async () => {
  const defaults = { model: { provider: 'p', id: 'm' }, thinkingLevel: 'high' }
  const reply = (value: unknown) =>
    invoke.mockImplementation(async (method) =>
      method === 'hosts:skills'
        ? { skills: [], probe: 'rpc', userRoot: 'opaque' }
        : method === 'hosts:models'
          ? { models, defaults: value }
          : [{ id: 'p', name: 'Provider', status: 'ready' }],
    )
  reply(defaults)
  await useMachineCataloguesStore.getState().load(MOCK_HOST_ID)
  expect(catalogue()).toMatchObject({ status: 'ready', models, defaults })
  reply({ ...defaults, theme: 'dark' })
  await useMachineCataloguesStore.getState().load(MOCK_HOST_ID, 'retry')
  expect(catalogue()).toMatchObject({ status: 'ready', models })
  expect(catalogue().defaults).toBeUndefined()
})
it('a save refreshes a ready list and preserves acknowledged defaults when the Host omits them', async () => {
  const defaults = { model: { provider: 'p', id: 'm' }, thinkingLevel: 'low' as const }
  recheckMachineCatalogue(MOCK_HOST_ID, defaults)
  expect(useMachineCataloguesStore.getState().catalogues).toEqual({})
  await useMachineCataloguesStore.getState().load(MOCK_HOST_ID)
  const state = useMachineCataloguesStore.getState()
  await state.load(MOCK_HOST_ID, 'recheck', defaults)
  expect(catalogue()).toMatchObject({ status: 'ready', models, defaults })
  await state.load(MOCK_HOST_ID, 'recheck', null)
  expect(catalogue().defaults).toBeUndefined()
  expect(invoke.mock.calls.filter(([channel]) => channel === 'hosts:models')).toHaveLength(3)
})
it('keeps acknowledged defaults on an ordinary refresh until the Host sends new defaults', async () => {
  const { load } = useMachineCataloguesStore.getState()
  await load(MOCK_HOST_ID)
  invoke.mockResolvedValueOnce({ agent: { defaultThinkingLevel: 'high' } })
  await patchHostSettings(MOCK_HOST_ID, {
    section: 'agent',
    revision: 'current',
    change: { type: 'agent.patch', patch: { defaultThinkingLevel: 'high' } },
  })
  await vi.waitFor(() => expect(catalogue().refreshing).toBe(false))
  expect(catalogue().defaults).toEqual({ thinkingLevel: 'high' })
  await load(MOCK_HOST_ID, 'recheck')
  expect(catalogue().defaults).toEqual({ thinkingLevel: 'high' })
  invoke.mockResolvedValueOnce({ models, defaults: {} })
  await load(MOCK_HOST_ID, 'recheck')
  expect(catalogue().defaults).toEqual({})
})
it('keeps the last complete list through partial refreshes, even when it is empty', async () => {
  const { load } = useMachineCataloguesStore.getState()
  await load(MOCK_HOST_ID)
  invoke.mockResolvedValueOnce({ models: [], source: 'config' })
  const refresh = load(MOCK_HOST_ID, 'recheck')
  expect(catalogue()).toMatchObject({ models, status: 'ready', refreshing: true })
  await refresh
  expect(catalogue()).toMatchObject({ models, status: 'ready', failures: 1 })
  expect(catalogue().source).toBeUndefined()
  invoke.mockResolvedValueOnce({ models: [] })
  await load(MOCK_HOST_ID, 'recheck')
  expect(catalogue()).toMatchObject({ models: [], failures: 0 })
  invoke.mockResolvedValueOnce({ models, source: 'config' })
  await load(MOCK_HOST_ID, 'retry')
  expect(catalogue()).toMatchObject({ models: [], status: 'ready', failures: 1 })
  expect(catalogue().source).toBeUndefined()
})
it('does not issue a read for a down or capability-less machine', async () => {
  const hosts = structuredClone(mockRemoteHosts)
  useRemoteLanesStore.setState({ hosts })
  await useMachineCataloguesStore.getState().load(MOCK_HOST_ID)
  expect(invoke).not.toHaveBeenCalled()
  expect(catalogue().error).toBe('This Host does not offer models to this device.')
  hosts[MOCK_HOST_ID]!.state = 'down'
  useRemoteLanesStore.setState({ hosts: structuredClone(hosts) })
  await useMachineCataloguesStore.getState().load(MOCK_HOST_ID)
  expect(invoke).not.toHaveBeenCalled()
  expect(catalogue().error).toBe('Machine not connected. Wait for reconnection.')
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
          ? { models }
          : [{ id: 'p', name: 'Provider', status: 'ready' }]
    })
    const pending = useMachineCataloguesStore.getState().load(MOCK_HOST_ID)
    await vi.waitFor(() => expect(resolve).toBeDefined())
    await useMachineCataloguesStore.getState().load(null)
    resolve?.(
      stage === 'hosts:models' ? { models } : [{ id: 'p', name: 'Provider', status: 'ready' }],
    )
    await pending
    expect(catalogue().models).toEqual(models)
    expect(catalogue().providers).toEqual([{ id: 'p', name: 'Provider', status: 'ready' }])
    expect(invoke).toHaveBeenCalledTimes(2)
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
  finish({ models })
  await pending
  expect(catalogue().models).toEqual(models)
  expect(useSkillsStore.getState().byWorkspace[`host:${MOCK_HOST_ID}/machine`]).toBeUndefined()
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
    if (outcome === 'reply') finish({ models })
    else fail(new Error('Connection closed.'))
    await pending
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(catalogue().error).toBeNull()
    expect(useSkillsStore.getState().byWorkspace[`host:${MOCK_HOST_ID}/machine`]).toBeUndefined()
  },
)

it('names what failed when a model read fails or replies with something unreadable', async () => {
  invoke.mockImplementation(async (method) => {
    if (method === 'hosts:skills') return { skills: [], probe: 'rpc', userRoot: 'opaque' }
    throw new Error('Connection closed.')
  })
  await useMachineCataloguesStore.getState().load(MOCK_HOST_ID)
  expect(catalogue().error).toBe('Could not read models.')
  invoke.mockImplementation(async (method) =>
    method === 'hosts:skills' ? { skills: [], probe: 'rpc', userRoot: 'opaque' } : 'unreadable',
  )
  await useMachineCataloguesStore.getState().load(MOCK_HOST_ID, 'retry')
  expect(catalogue().error).toBe('Could not read models.')
})

function catalogue() {
  return (
    useMachineCataloguesStore.getState().catalogues[machineCatalogueKey(MOCK_HOST_ID)] ??
    EMPTY_MACHINE_CATALOGUE
  )
}
