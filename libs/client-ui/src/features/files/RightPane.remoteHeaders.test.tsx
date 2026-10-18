// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RightPane } from './RightPane'
import { useLayoutStore } from '@/stores/layout'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('./RemoteFilesPane', () => ({ RemoteFilesPane: () => <p>remote files body</p> }))
vi.mock('@/features/artifacts/RemoteArtifactsPane', () => ({
  RemoteArtifactsPane: () => <header>Artifacts own header</header>,
}))
vi.mock('@/features/terminal/TerminalPane', () => ({
  TerminalPane: () => <header>Terminal own header</header>,
}))

const id = mockRemoteInfo.sessionId
const container = document.createElement('div')
const root = createRoot(container)
afterEach(() => act(() => root.render(<></>)))

function show(pane: 'files' | 'changes' | 'artifacts' | 'terminal', capabilities: string[]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID])!
  host.state = 'ready'
  host.capabilities = capabilities as typeof host.capabilities
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  useSessionsStore.setState({ live: { [id]: { ...mockRemoteInfo, phosphorId: id } } })
  act(() => {
    useLayoutStore.getState().setRightPane(pane, id)
    root.render(<RightPane sessionId={id} workspacePath={mockRemoteInfo.workspacePath} />)
  })
}
const shells = () =>
  [...container.querySelectorAll('button')].filter((b) =>
    /Move pane to the/.test(b.getAttribute('aria-label') ?? b.title ?? b.textContent ?? ''),
  ).length

it.each(['artifacts', 'terminal'] as const)(
  'a remote %s pane keeps its own single header, like This Mac',
  (pane) => {
    show(pane, ['sessions.read', 'artifacts.read', 'terminal'])
    expect(container.textContent).toContain('own header')
    expect(shells()).toBe(0)
  },
)

it('remote Files uses the Files/Changes switcher with the machine chip in one header', () => {
  show('files', ['sessions.read', 'workspaces.read'])
  expect(shells()).toBe(1)
  const files = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Files')
  expect(files?.getAttribute('aria-pressed')).toBe('true')
  expect(container.textContent).toContain('Connected')
  expect(container.textContent).toContain('remote files body')
})

it('a refusal still gets a titled header', () => {
  show('terminal', ['sessions.read'])
  expect(shells()).toBe(1)
  expect(container.textContent).toContain('Terminal')
  expect(container.textContent).toContain('Not available on remote lanes yet.')
})
