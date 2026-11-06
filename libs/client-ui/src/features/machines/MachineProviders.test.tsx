// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { MachineProviders } from './MachineProviders'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { MACHINE } from './__fixtures__/control'
let root: Root, container: HTMLDivElement
const invoke = vi.fn(async (channel: string): Promise<unknown> => {
  if (channel === 'hosts:providers') return [{ id: 'xai', name: 'xAI', status: 'not_ready' }]
})
beforeEach(() => {
  invoke.mockClear()
  vi.stubGlobal('phosphor', { invoke })
  useRemoteLanesStore.setState({
    hosts: {
      host: {
        state: 'ready',
        capabilities: ['terminal', 'sessions.control', 'skills.read'],
        repositories: [],
        lanes: [],
        connectionToken: 'test-connection-1',
      },
    },
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
async function render(onConfigure?: () => void) {
  await act(async () => root.render(<MachineProviders hostId="host" onConfigure={onConfigure} />))
}
it("shows the Host's providers read-only, with Settings' rows and words", async () => {
  const configure = vi.fn()
  await render(configure)
  const row = container.querySelector('[data-provider=xai]')!
  expect(row.textContent).toContain('Not signed in')
  expect(row.textContent).toContain('Requires an xAI account.')
  expect(row.querySelector('button')).toBeNull()
  const settings = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Provider settings',
  )!
  await act(async () => settings.click())
  expect(configure).toHaveBeenCalledOnce()
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['hosts:providers'])
})
it('keeps the CLI command for a Host that cannot be configured from here', async () => {
  await render()
  expect(container.textContent).toContain('phosphor providers login PROVIDER')
})
it('shows a retryable error instead of an empty list when the provider read fails', async () => {
  let fail = true
  const base = invoke.getMockImplementation()
  onTestFinished(() => {
    if (base) invoke.mockImplementation(base)
  })
  invoke.mockImplementation(async (channel: string): Promise<unknown> => {
    if (channel !== 'hosts:providers') return undefined
    if (fail) throw new Error('busy')
    return [{ id: 'openai-codex', name: 'ChatGPT', status: 'ready' }]
  })
  await render()
  expect(container.textContent).toContain("Could not load this machine's providers.")
  fail = false
  const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')
  await act(async () => retry?.click())
  expect(container.textContent).not.toContain('Could not load')
  expect(container.querySelector('[data-provider=openai-codex]')?.textContent).toContain(
    'ChatGPTSigned in',
  )
})
it('shows loading rows while the first read is in flight, and a hint when not connected', async () => {
  let finish = (_: unknown) => {}
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await render()
  expect(container.querySelector('[role=status]')?.getAttribute('aria-label')).toBe(
    'Loading providers',
  )
  await act(async () => finish([{ id: 'xai', name: 'xAI', status: 'not_ready' }]))
  expect(container.querySelector('[role=status]')).toBeNull()
  useRemoteLanesStore.setState({ hosts: {} })
  await render()
  expect(container.textContent).toContain('Providers appear once this computer is connected')
})
it('says a connected Host without the grant does not let this device read providers', async () => {
  useRemoteLanesStore.setState({
    hosts: {
      host: {
        state: 'ready',
        capabilities: ['terminal', 'sessions.control'],
        repositories: [],
        lanes: [],
        connectionToken: 'test-connection-1',
      },
    },
  })
  useMachinesStore.setState({ machines: [{ ...MACHINE, id: 'host', label: 'Build box' }] })
  onTestFinished(() => useMachinesStore.setState({ machines: [] }))
  await render()
  expect(container.textContent).toContain('This device may not read providers on Build box.')
  expect(container.textContent).not.toContain('once this computer is connected')
  expect(invoke).not.toHaveBeenCalled()
})
it('says "Checking providers…" while the first read is in flight', async () => {
  invoke.mockImplementationOnce(() => new Promise(() => {}))
  await render()
  expect(container.querySelector('[role=status]')?.textContent).toContain('Checking providers…')
})
it("reuses This Mac's last provider read on open, and reads again on Check again", async () => {
  const local = vi.fn(async () => [{ id: 'anthropic', name: 'Claude', status: 'ready' }])
  vi.stubGlobal('phosphor', { invoke: local })
  const open = async (refresh: number) => {
    act(() => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(<MachineProviders hostId="local" refresh={refresh} />))
  }
  await open(0)
  await open(0)
  expect(container.querySelector('[data-provider=anthropic]')?.textContent).toContain('Signed in')
  expect(local).toHaveBeenCalledOnce()
  await act(async () => root.render(<MachineProviders hostId="local" refresh={1} />))
  expect(local).toHaveBeenCalledTimes(2)
})
it("keeps reusing This Mac's last read on later opens after one Check again", async () => {
  const local = vi.fn(async () => [{ id: 'anthropic', name: 'Claude', status: 'ready' }])
  vi.stubGlobal('phosphor', { invoke: local })
  // The page stays mounted, so Check again's round outlives the detail it ran in.
  const open = async (refresh: number) => {
    act(() => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(<MachineProviders hostId="local" refresh={refresh} />))
  }
  await open(0)
  local.mockClear()
  await act(async () => root.render(<MachineProviders hostId="local" refresh={1} />))
  expect(local).toHaveBeenCalledOnce()
  await open(1)
  await open(1)
  expect(container.querySelector('[data-provider=anthropic]')?.textContent).toContain('Signed in')
  expect(local).toHaveBeenCalledOnce()
})
