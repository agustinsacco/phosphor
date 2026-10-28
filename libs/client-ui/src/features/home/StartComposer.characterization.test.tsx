// @vitest-environment jsdom
import { act, createRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { DESKTOP_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachineCataloguesStore } from '@/stores/machineCatalogues'
import { clearDraftMemory, homeDraftKey, useDraftsStore } from '@/stores/drafts'
import { useHomeSubmissionsStore } from '@/stores/homeSubmissions'
import { useStartingChatStore } from '@/stores/startingChat'
import { useWorktreesStore } from '@/stores/worktrees'
import { LocalHomeComposer } from './LocalHomeComposer'
import { RemoteStartView } from './RemoteStartView'
import { submitLocalHome } from './submitLocalHome'

vi.mock('./submitLocalHome', () => ({ submitLocalHome: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/features/voice/DictateButton', () => ({ DictateButton: () => null }))
vi.mock('./HomeModelPicker', () => ({ HomeModelPicker: () => <span>Local model</span> }))
vi.mock('@/features/workspaces/WorkspaceChip', () => ({ WorkspaceChip: () => <span>ws</span> }))
vi.mock('@/features/worktrees/BranchControl', () => ({ BranchControl: () => <span>main</span> }))
vi.mock('@/features/chat/composer/ContextSourcesMenu', () => ({
  ContextSourcesMenu: () => <span>Rules</span>,
}))

const WS = '/ws'
const localKey = homeDraftKey(WS)
const hostKey = homeDraftKey(`host:${MOCK_HOST_ID}/machine`)
let root: Root
let el: HTMLDivElement
let restore: () => void
let fake: ReturnType<typeof createFakePhosphor>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  fake = createFakePhosphor({
    'git:info': () => ({ isRepo: true }) as never,
    'git:startPoint': () => ({ defaultBranch: 'main' }) as never,
    'fs:listFiles': () => [],
    'pi:commands': () => ({ commands: [] }),
    'app:setDraft': () => undefined,
    'app:clearDraft': () => undefined,
  })
  restore = installFakePhosphor(fake)
  vi.mocked(submitLocalHome).mockClear()
  useRemoteLanesStore.setState({
    hosts: { [MOCK_HOST_ID]: structuredClone(mockRemoteHosts[MOCK_HOST_ID]!) },
  })
  useMachineCataloguesStore.setState({ catalogues: {} })
  useHomeSubmissionsStore.setState({ pending: {} })
  useStartingChatStore.setState({ starting: null, draft: null })
  useWorktreesStore.setState({ preferWorktree: true })
  clearDraftMemory()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  clearDraftMemory()
  restore()
  fake.dispose()
  vi.unstubAllGlobals()
})
const machine = <button aria-label="Machine">Picker</button>
async function render(content: ReactNode): Promise<void> {
  await act(async () =>
    root.render(<PlatformProvider value={DESKTOP_PLATFORM}>{content}</PlatformProvider>),
  )
}
const local = () => (
  <LocalHomeComposer workspacePath={WS} textareaRef={createRef()} machinePicker={machine} />
)
const host = () => <RemoteStartView hostId={MOCK_HOST_ID} machinePicker={machine} />
const submit = () =>
  [...el.querySelectorAll('button')].find((b) =>
    /^Start (session|lane)$/.test(b.getAttribute('aria-label') ?? ''),
  )!
const follows = (a: Element, b: Element) =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

it('local start composer puts its target row above a two-row input and hints below it', async () => {
  await render(local())
  const field = el.querySelector('textarea')!
  expect(field.getAttribute('placeholder')).toBe('Describe a task or ask a question')
  expect(field.getAttribute('rows')).toBe('2')
  const picker = el.querySelector('[aria-label=Machine]')!
  const isolate = el.querySelector('input[type=checkbox]')!
  expect(follows(picker, isolate)).toBe(true)
  expect(follows(isolate, field)).toBe(true)
  expect(el.textContent).toContain('Rules')
  expect(el.textContent).toContain('/ commands · @ files')
})

it('local start composer submits once and refuses while a start or submission is pending', async () => {
  useDraftsStore.getState().setText(localKey, 'Local task')
  await render(local())
  useHomeSubmissionsStore.getState().begin(localKey)
  await act(async () => submit().click())
  expect(submitLocalHome).not.toHaveBeenCalled()
  useHomeSubmissionsStore.setState({ pending: {} })
  act(() => useStartingChatStore.getState().begin({ workspacePath: WS, prompt: 'other' }))
  await act(async () => submit().click())
  expect(submitLocalHome).not.toHaveBeenCalled()
  act(() => useStartingChatStore.setState({ starting: null }))
  await act(async () => submit().click())
  expect(submitLocalHome).toHaveBeenCalledExactlyOnceWith(WS, 'Local task', [], false)
})

it('local start composer takes a failed start back into its draft with the reason', async () => {
  useStartingChatStore.setState({
    draft: { workspacePath: WS, text: 'Lost task', attachments: [], message: 'Could not start.' },
  })
  await render(local())
  expect(el.querySelector('textarea')!.value).toBe('Lost task')
  expect(el.textContent).toContain('Could not start.')
  expect(useStartingChatStore.getState().draft).toBeNull()
  expect(useDraftsStore.getState().drafts[localKey]?.text).toBe('Lost task')
})

it('Host start composer shares the placeholder and locks with a reason until it can start', async () => {
  const ready = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: { ...ready, state: 'down' } } })
  useDraftsStore.getState().setText(hostKey, 'Host task')
  await render(host())
  const field = el.querySelector('textarea')!
  expect(field.getAttribute('placeholder')).toBe('Describe a task or ask a question')
  expect(field.matches(':disabled')).toBe(true)
  expect(el.querySelector('fieldset')!.getAttribute('aria-busy')).toBeNull()
  expect(el.textContent).toContain(
    'Connect this machine with session control before creating a lane.',
  )
  await act(async () =>
    useRemoteLanesStore.setState({
      hosts: { [MOCK_HOST_ID]: { ...ready, state: 'connecting', connectionToken: 'next' } },
    }),
  )
  expect(el.querySelector('fieldset')!.getAttribute('aria-busy')).toBe('true')
  expect(el.textContent).toContain(`Connecting to ${MOCK_HOST_ID}…`)
  expect(el.textContent).not.toContain('Connect this machine')
  await act(async () =>
    useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: { ...ready, repositories: [] } } }),
  )
  expect(field.matches(':disabled')).toBe(false)
  expect(el.textContent).toContain('Choose or add a repository on this machine.')
  expect(submit().disabled).toBe(true)
  expect(field.value).toBe('Host task')
})

it('Host start composer keeps the machine picker, then Repository, then the isolate toggle', async () => {
  await render(host())
  const picker = el.querySelector('[aria-label=Machine]')!
  const repository = el.querySelector('[aria-label=Repository]')!
  const isolate = el.querySelector('input[type=checkbox]')!
  expect(follows(picker, repository)).toBe(true)
  expect(follows(repository, isolate)).toBe(true)
  expect(repository.textContent).toContain('Demo repository')
})

it('Host start composer without a machine picker names its machine', async () => {
  await render(<RemoteStartView hostId={MOCK_HOST_ID} />)
  const repository = el.querySelector('[aria-label=Repository]')!
  const name = [...el.querySelectorAll('span')].find((s) => s.textContent === MOCK_HOST_ID)!
  expect(follows(name, repository)).toBe(true)
})
