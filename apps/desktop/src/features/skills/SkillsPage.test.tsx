// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SKILL_CATALOG } from '@shared/skillsCatalog'
import { useSkillsStore } from '@/stores/skills'
import { SkillsPage } from './SkillsPage'

vi.mock('@/components/markdown/Markdown', () => ({ Markdown: () => null }))
const container = document.createElement('div')
const root = createRoot(container)
afterEach(() => {
  act(() => root.render(null))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function render(): Promise<ReturnType<typeof vi.fn>> {
  const invoke = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('phosphor', { invoke })
  vi.spyOn(useSkillsStore.getState(), 'refresh').mockResolvedValue(undefined)
  useSkillsStore.setState({ tab: 'discover', selectedDir: null, byWorkspace: {} })
  await act(async () => root.render(<SkillsPage workspacePath="/repo" />))
  return invoke
}

function button(label: string): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find(
    (node) => node.getAttribute('aria-label') === label || node.textContent === label,
  )!
}

it('shows evidence limits, filters by outcome, and never installs an external plugin', async () => {
  const invoke = await render()
  expect(container.textContent).toContain('not a measured gain for this skill')
  expect(container.querySelectorAll('article')).toHaveLength(SKILL_CATALOG.length)
  await act(async () => button('Audit & verify').click())
  expect(button('Audit & verify').getAttribute('aria-pressed')).toBe('true')
  expect(container.querySelectorAll('article')).toHaveLength(1)
  expect(container.textContent).toContain('Precision is not reported')
  expect(container.querySelector('[aria-label^="Add "]')).toBeNull()
  await act(async () => button('Read evaluation ↗').click())
  expect(invoke).toHaveBeenCalledWith(
    'app:openExternal',
    expect.stringContaining('trailofbits.com'),
  )
  expect(invoke).not.toHaveBeenCalledWith('skills:install', expect.anything(), expect.anything())
})

it('keeps installation behind review and surfaces failures without pretending success', async () => {
  const invoke = await render()
  const add = button('Add react-best-practices')
  expect(add.closest('details')?.open).toBe(false)
  invoke.mockRejectedValueOnce(new Error('Download failed'))
  await act(async () => add.click())
  expect(invoke).toHaveBeenCalledWith('skills:install', 'vercel-react', 'react-best-practices')
  expect(container.textContent).toContain('Download failed')
  expect(add.disabled).toBe(false)
  invoke.mockResolvedValueOnce(undefined)
  await act(async () => add.click())
  expect(useSkillsStore.getState().refresh).toHaveBeenCalledWith('/repo')
  expect(container.textContent).not.toContain('Download failed')
})

it('keeps every offering pinned and external plugins outside the installer allowlist', () => {
  expect(new Set(SKILL_CATALOG.map((entry) => entry.id)).size).toBe(SKILL_CATALOG.length)
  for (const library of SKILL_CATALOG) {
    expect(library.sha).toMatch(/^[a-f0-9]{40}$/)
    if (library.offering) {
      expect(library.offering.evidenceUrl).toMatch(/^https:\/\//)
      expect(library.offering.caveat).not.toBe('')
      expect(library.skills.length === 0).toBe(!!library.offering.external)
    }
  }
})

it('keeps remote skills read-only, gates capability and never offers local installation', async () => {
  const { useRemoteLanesStore } = await import('@/stores/remoteLanes')
  const hostId = '00000000-0000-4000-8000-000000000001'
  const workspacePath = `host:${hostId}/0123456789abcdef`
  const invoke = vi.fn().mockResolvedValue({ content: 'skill text', binary: false, size: 10 })
  vi.stubGlobal('phosphor', { invoke })
  vi.spyOn(useSkillsStore.getState(), 'refresh').mockResolvedValue(undefined)
  useSkillsStore.setState({
    tab: 'discover',
    selectedDir: null,
    byWorkspace: {
      [workspacePath]: {
        skills: [
          {
            name: 'remote-skill',
            description: 'Remote skill',
            dir: `${workspacePath}/skill:remote-skill`,
            scope: 'user',
            source: 'host',
            origin: 'top-level',
            writable: false,
            borrowed: false,
            draft: false,
            files: [{ path: 'SKILL.md', size: 0 }],
            totalSize: 0,
            warnings: [],
          },
        ],
        probe: 'rpc',
        userRoot: workspacePath,
      },
    },
  })
  useRemoteLanesStore.setState({ hosts: {} })
  await act(async () => root.render(<SkillsPage workspacePath={workspacePath} />))
  expect(container.textContent).toContain('Not available on remote lanes yet.')
  const host = {
    connectionToken: 'test-connection-1',
    state: 'ready' as const,
    capabilities: ['skills.read'] as const,
    repositories: [],
    lanes: [],
  }
  await act(async () =>
    useRemoteLanesStore.setState({
      hosts: { [hostId]: { ...host, capabilities: [...host.capabilities] } },
    }),
  )
  expect(container.textContent).toContain('Remote skill')
  expect(container.textContent).not.toContain('Discover')
  expect(container.textContent).not.toContain('New skill')
  expect(container.textContent).not.toContain('Upload')
  await act(async () => useSkillsStore.getState().select(`${workspacePath}/skill:remote-skill`))
  expect(invoke).toHaveBeenCalledWith(
    'skills:readFile',
    `${workspacePath}/skill:remote-skill`,
    'SKILL.md',
  )
  for (const label of ['Delete', 'Edit', 'Publish', 'Update', 'Export'])
    expect(container.textContent).not.toContain(label)
  await act(async () => useRemoteLanesStore.setState({ hosts: {} }))
  expect(container.textContent).toContain('Not available on remote lanes yet.')
})

it('switches to machine-wide skills and shows that machines models/providers without local calls', async () => {
  const { useRemoteLanesStore } = await import('@/stores/remoteLanes')
  const { useMachinePagesStore } = await import('@/stores/machinePages')
  const { useSessionsStore } = await import('@/stores/sessions')
  const { mockRemoteHosts, MOCK_HOST_ID } = await import('@/dev/mockRemoteLanes')
  useMachinePagesStore.setState({ skillsMachine: null })
  useSessionsStore.setState({ live: {}, activeSessionId: null })
  const host = mockRemoteHosts[MOCK_HOST_ID]
  if (!host) throw new Error('Missing host')
  useRemoteLanesStore.setState({
    hosts: { [MOCK_HOST_ID]: { ...host, capabilities: ['skills.read'] } },
  })
  vi.spyOn(useSkillsStore.getState(), 'refresh').mockResolvedValue(undefined)
  const invoke = vi.fn(async (method: string) =>
    method === 'hosts:skills'
      ? { skills: [], probe: 'rpc', userRoot: 'opaque' }
      : method === 'hosts:models'
        ? [{ id: 'm', name: 'Host model', provider: 'p', reasoning: false }]
        : [{ id: 'p', name: 'Host provider', status: 'ready' }],
  )
  vi.stubGlobal('phosphor', { invoke })
  await act(async () => root.render(<SkillsPage workspacePath="/repo" />))
  Element.prototype.scrollIntoView = vi.fn()
  const picker = container.querySelector<HTMLButtonElement>('button[aria-label="Machine"]')
  expect(picker?.textContent).toContain('This Mac')
  await act(async () => picker?.click())
  const hostOption = [...container.querySelectorAll<HTMLButtonElement>('[role=option]')].find((o) =>
    o.textContent?.includes(MOCK_HOST_ID),
  )
  await act(async () => hostOption?.click())
  expect(container.textContent).toContain('Host model')
  expect(container.textContent).toContain('Host provider: Signed in')
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
    'hosts:skills',
    'hosts:models',
    'hosts:providers',
  ])
  expect(container.textContent).not.toContain('Upload')
  useMachinePagesStore.setState({ skillsMachine: null })
})

it('does not restart a delayed catalogue on unchanged periodic snapshots', async () => {
  const { useRemoteLanesStore } = await import('@/stores/remoteLanes')
  const { useMachinePagesStore } = await import('@/stores/machinePages')
  const { mockRemoteHosts, MOCK_HOST_ID } = await import('@/dev/mockRemoteLanes')
  useMachinePagesStore.setState({ skillsMachine: MOCK_HOST_ID })
  const host = mockRemoteHosts[MOCK_HOST_ID]!
  useRemoteLanesStore.setState({
    hosts: { [MOCK_HOST_ID]: { ...host, capabilities: ['skills.read'] } },
  })
  let finish!: (value: unknown) => void
  const invoke = vi.fn().mockImplementation(async (method) => {
    if (method === 'hosts:skills')
      return new Promise((resolve) => {
        finish = resolve
      })
    if (method === 'hosts:models')
      return [{ id: 'm', name: 'Delayed model', provider: 'p', reasoning: false }]
    return [{ id: 'p', name: 'Provider', status: 'ready' }]
  })
  vi.stubGlobal('phosphor', { invoke })
  await act(async () => root.render(<SkillsPage workspacePath="/repo" />))
  const first = finish
  for (let tick = 0; tick < 3; tick++)
    await act(async () => {
      useRemoteLanesStore.setState({ hosts: structuredClone(useRemoteLanesStore.getState().hosts) })
    })
  await act(async () => first({ skills: [], probe: 'rpc', userRoot: 'opaque' }))
  expect(container.textContent).toContain('Delayed model')
  expect(invoke).toHaveBeenCalledTimes(3)
  useMachinePagesStore.setState({ skillsMachine: null })
})

it('reloads after a coalesced ready-to-ready reconnect and ignores the old failure', async () => {
  const { useRemoteLanesStore } = await import('@/stores/remoteLanes')
  const { useMachinePagesStore } = await import('@/stores/machinePages')
  const { useMachineCataloguesStore } = await import('@/stores/machineCatalogues')
  const { mockRemoteHosts, MOCK_HOST_ID } = await import('@/dev/mockRemoteLanes')
  useMachinePagesStore.setState({ skillsMachine: MOCK_HOST_ID })
  useRemoteLanesStore.setState({
    hosts: { [MOCK_HOST_ID]: { ...mockRemoteHosts[MOCK_HOST_ID]!, capabilities: ['skills.read'] } },
  })
  let fail!: (error: Error) => void
  const invoke = vi
    .fn()
    .mockImplementation(async (method) => {
      if (method === 'hosts:skills') return { skills: [], probe: 'rpc', userRoot: 'opaque' }
      if (method === 'hosts:models')
        return [{ id: 'm', name: 'Reconnected model', provider: 'p', reasoning: false }]
      return [{ id: 'p', name: 'Provider', status: 'ready' }]
    })
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    )
  vi.stubGlobal('phosphor', { invoke })
  await act(async () => root.render(<SkillsPage workspacePath="/repo" />))
  await act(async () => {
    useRemoteLanesStore.setState((s) => ({
      hosts: {
        ...s.hosts,
        [MOCK_HOST_ID]: { ...s.hosts[MOCK_HOST_ID]!, connectionToken: 'reconnected' },
      },
    }))
    fail(new Error('Connection closed.'))
  })
  expect(container.textContent).toContain('Reconnected model')
  expect(invoke).toHaveBeenCalledTimes(4)
  expect(useMachineCataloguesStore.getState().error).toBeNull()
  useMachinePagesStore.setState({ skillsMachine: null })
})
