// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MachineFilesPane } from './MachineFilesPane'
import { PlatformProvider, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
vi.mock('@/lib/monaco', () => ({}))
vi.mock('./MonacoEditor', () => ({
  releaseFileModel: vi.fn(),
  MonacoEditor: ({ value }: { value: string }) => <pre>{value}</pre>,
}))
const repositoryId = '1234567890abcdef'
const invoke = vi.fn(async (channel: string) =>
  channel === 'hosts:repositoryFiles'
    ? ['README.md']
    : { binary: false, content: 'Remote preview' },
)
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { phosphor: { invoke } })
  invoke.mockClear()
  useRemoteLanesStore.setState({
    hosts: {
      host: {
        connectionToken: 'test',
        state: 'ready',
        capabilities: ['workspaces.read'],
        repositories: [{ id: repositoryId, name: 'Remote repo', path: '/not-used' }],
        lanes: [],
      },
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
it('browses and previews configured repositories read-only, without local IPC', async () => {
  await act(async () => root.render(<MachineFilesPane hostId="host" />))
  const select = container.querySelector('select')
  if (!select) throw new Error('missing select')
  await act(async () => {
    select.value = repositoryId
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(invoke).toHaveBeenCalledWith('hosts:repositoryFiles', 'host', repositoryId)
  await act(async () => container.querySelector('button')?.click())
  expect(container.textContent).toContain('Remote preview')
  expect(invoke.mock.calls.every(([c]) => c.startsWith('hosts:repository'))).toBe(true)
  expect(container.textContent).toContain('Read only')
})
it('shows refusal for a down machine and never calls local files', async () => {
  useRemoteLanesStore.setState((s) => ({ hosts: { host: { ...s.hosts.host!, state: 'down' } } }))
  await act(async () => root.render(<MachineFilesPane hostId="host" />))
  expect(container.querySelector('select')).toBeNull()
  expect(invoke).not.toHaveBeenCalled()
})
it('never enables the native editor just because the browser is wide', async () => {
  const native = vi.spyOn(await import('./MonacoEditor'), 'MonacoEditor')
  try {
    await act(async () =>
      root.render(
        <PlatformProvider value={WIDE_BROWSER_PLATFORM}>
          <MachineFilesPane hostId="host" />
        </PlatformProvider>,
      ),
    )
    const select = container.querySelector('select')!
    await act(async () => {
      select.value = repositoryId
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => container.querySelector('button')?.click())
    expect(container.textContent).toContain('Remote preview')
    expect(native).not.toHaveBeenCalled()
    expect(invoke.mock.calls.every(([channel]) => channel.startsWith('hosts:repository'))).toBe(
      true,
    )
  } finally {
    native.mockRestore()
  }
})

it('clears selection and preview on machine A -> B -> A switches', async () => {
  const a = useRemoteLanesStore.getState().hosts.host
  if (!a) throw new Error('fixture')
  useRemoteLanesStore.setState({
    hosts: {
      host: a,
      other: { ...a, repositories: [{ id: repositoryId, name: 'Other repo', path: '/not-used' }] },
    },
  })
  for (const hostId of ['host', 'other', 'host']) {
    await act(async () => root.render(<MachineFilesPane hostId={hostId} />))
    expect(container.textContent).not.toContain('Remote preview')
    expect(container.querySelector('select')?.value).toBe('')
    const select = container.querySelector('select')
    if (!select) throw new Error('select')
    await act(async () => {
      select.value = repositoryId
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => container.querySelector('button')?.click())
    expect(invoke).toHaveBeenCalledWith('hosts:repositoryFile', hostId, repositoryId, 'README.md')
    expect(container.textContent).toContain('Remote preview')
  }
})
it("chooses among the Host's registered repositories", async () => {
  await act(async () => root.render(<MachineFilesPane hostId="host" />))
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Repository"]')
  expect([...(select?.options ?? [])].map((o) => [o.value, o.textContent])).toEqual([
    ['', 'Choose a repository'],
    [repositoryId, 'Remote repo'],
  ])
  expect(invoke).not.toHaveBeenCalled()
})
it('names what it browses: a Host its repositories', async () => {
  const words = () => [
    container.querySelector('h2')?.textContent,
    container.querySelector('select')?.getAttribute('aria-label'),
    container.querySelector('option')?.textContent,
    container.querySelector('nav')?.getAttribute('aria-label'),
  ]
  await act(async () => root.render(<MachineFilesPane hostId="host" />))
  expect(words()).toEqual([
    'Repositories Read only',
    'Repository',
    'Choose a repository',
    'Repository files',
  ])
})
it('shows a failed list or read as an alert until the repository changes', async () => {
  const base = invoke.getMockImplementation()!
  const fail = (failing: string) =>
    invoke.mockImplementation(async (channel: string) => {
      if (channel === failing) throw new Error('failed')
      return (
        channel === 'hosts:repositoryFiles' ? ['README.md'] : { binary: false, content: 'Remote' }
      ) as never
    })
  const choose = async (value: string) => {
    const select = container.querySelector('select')!
    await act(async () => {
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  const alert = () => container.querySelector('[role="alert"]')?.textContent ?? null
  try {
    await act(async () => root.render(<MachineFilesPane hostId="host" />))
    fail('hosts:repositoryFiles')
    await choose(repositoryId)
    expect(alert()).toBe('Could not read files.')
    await choose('')
    expect(alert()).toBeNull()
    fail('hosts:repositoryFile')
    await choose(repositoryId)
    await act(async () => container.querySelector<HTMLButtonElement>('nav button')?.click())
    expect(alert()).toBe('Could not read this file.')
    await choose('')
    expect(alert()).toBeNull()
  } finally {
    invoke.mockImplementation(base)
  }
})
