// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { ProviderSignIn } from './ProviderSignIn'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
vi.mock('@/features/terminal/TerminalView', () => ({
  TerminalView: () => <div>Login terminal</div>,
}))
let root: Root, container: HTMLDivElement
let exit = (_: number) => {}
const invoke = vi.fn(async (channel: string): Promise<unknown> => {
  if (channel === 'hosts:providers') return [{ id: 'xai', name: 'xAI', status: 'not_ready' }]
  if (channel === 'hosts:providerLogin') return { ptyId: 'remote-pty-test' }
})
beforeEach(() => {
  invoke.mockClear()
  vi.stubGlobal('phosphor', {
    invoke,
    onPtyExit: vi.fn((_id, cb) => {
      exit = cb
      return () => {}
    }),
  })
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
async function render() {
  await act(async () => root.render(<ProviderSignIn hostId="host" />))
}
it('opens the Host terminal and refreshes provider readiness on exit', async () => {
  await render()
  expect(container.textContent).toContain('Not signed in')
  await act(async () => container.querySelector('button')?.click())
  expect(invoke).toHaveBeenCalledWith('hosts:providerLogin', 'host', 'xai')
  expect(document.body.textContent).toContain('Login terminal')
  await act(async () => exit(0))
  expect(invoke.mock.calls.filter(([channel]) => channel === 'hosts:providers')).toHaveLength(2)
  expect(document.body.textContent).not.toContain('Login terminal')
})
it.each(['terminal', 'sessions.control'] as const)(
  'keeps the CLI hint without %s',
  async (missing) => {
    const host = useRemoteLanesStore.getState().hosts.host
    if (!host) throw new Error('missing Host')
    useRemoteLanesStore.setState({
      hosts: { host: { ...host, capabilities: host.capabilities.filter((c) => c !== missing) } },
    })
    await render()
    expect(container.textContent).toContain('phosphor providers login xai')
    expect(container.querySelector('button')).toBeNull()
  },
)

it('kills a confirmed login when navigation happened during admission', async () => {
  await render()
  let complete = (_: unknown) => {}
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  await act(async () => container.querySelector('button')?.click())
  await act(async () => root.render(<div>Other page</div>))
  await act(async () => complete({ ptyId: 'remote-pty-late' }))
  expect(invoke).toHaveBeenCalledWith('pty:kill', 'remote-pty-late')
  expect(document.body.textContent).not.toContain('Login terminal')
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
  expect(container.textContent).toContain('ChatGPT: Signed in')
})
