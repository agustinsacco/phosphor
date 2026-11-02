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
import { clearDraftMemory } from '@/stores/drafts'
import { useHomeSubmissionsStore } from '@/stores/homeSubmissions'
import { useStartingChatStore } from '@/stores/startingChat'
import { useWorktreesStore } from '@/stores/worktrees'
import { LocalHomeComposer } from './LocalHomeComposer'
import { RemoteStartView } from './RemoteStartView'

vi.mock('@/features/voice/DictateButton', () => ({ DictateButton: () => null }))
vi.mock('./HomeModelPicker', () => ({ HomeModelPicker: () => <span>Local model</span> }))
vi.mock('@/features/workspaces/WorkspaceChip', () => ({ WorkspaceChip: () => <span>ws</span> }))
vi.mock('@/features/worktrees/BranchControl', () => ({ BranchControl: () => <span>main</span> }))
vi.mock('@/features/chat/composer/ContextSourcesMenu', () => ({
  ContextSourcesMenu: () => <span>Rules</span>,
}))

const REPOSITORY = mockRemoteHosts[MOCK_HOST_ID]!.repositories[0]!.id
let root: Root
let el: HTMLDivElement
let restore: () => void
let fake: ReturnType<typeof createFakePhosphor>
let repositoryFiles: ReturnType<typeof vi.fn>
let listFiles: ReturnType<typeof vi.fn>
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
  repositoryFiles = vi.fn(() => ['src/host-only.ts', 'README.md'])
  listFiles = vi.fn(() => ['mac-only.ts'])
  fake = createFakePhosphor({
    'git:info': () => ({ isRepo: true }) as never,
    'git:startPoint': () => ({ defaultBranch: 'main' }) as never,
    'fs:listFiles': listFiles as never,
    'pi:commands': () => ({ commands: [] }),
    'hosts:repositoryFiles': repositoryFiles as never,
    'app:setDraft': () => undefined,
    'app:clearDraft': () => undefined,
  })
  restore = installFakePhosphor(fake)
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.capabilities.push('workspaces.read')
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
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
async function type(value: string): Promise<void> {
  const field = el.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(field, value)
    field.setSelectionRange(value.length, value.length)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Landmarks in document order, plus what the input and submit button say. */
function structure(): string[] {
  const field = el.querySelector('textarea')!
  const submit = [...el.querySelectorAll('button')].find((b) =>
    /^Start /.test(b.getAttribute('aria-label') ?? ''),
  )!
  const isolate = el.querySelector('input[type=checkbox]')
  const marks: [string, Element][] = [
    ['machine', el.querySelector('[aria-label=Machine]')!],
    ...(isolate ? [['isolate', isolate] as [string, Element]] : []),
    ['input', field],
    ['submit', submit],
  ]
  marks.sort(([, a], [, b]) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  )
  return [
    ...marks.map(([name]) => name),
    `rows=${field.getAttribute('rows')}`,
    `placeholder=${field.getAttribute('placeholder')}`,
    `submit=${submit.getAttribute('aria-label')}`,
  ]
}

// A Host lane always gets a worktree, so only This Mac offers the isolate toggle.
it('renders the Host start composer with the same structure and submit label as This Mac', async () => {
  await render(
    <LocalHomeComposer workspacePath="/ws" textareaRef={createRef()} machinePicker={machine} />,
  )
  const local = structure()
  await render(<RemoteStartView hostId={MOCK_HOST_ID} machinePicker={machine} />)
  expect(structure()).toEqual(local.filter((mark) => mark !== 'isolate'))
  expect(local).toEqual([
    'machine',
    'isolate',
    'input',
    'submit',
    'rows=2',
    'placeholder=Describe a task or ask a question',
    'submit=Start lane',
  ])
})

it('lists the Host repository files for @ mentions in a new Host lane', async () => {
  await render(<RemoteStartView hostId={MOCK_HOST_ID} machinePicker={machine} />)
  await type('Look at @host')
  expect(repositoryFiles).toHaveBeenCalledWith(MOCK_HOST_ID, REPOSITORY)
  expect(listFiles).not.toHaveBeenCalled()
  expect(el.textContent).toContain('src/host-only.ts')
  expect(el.textContent).not.toContain('mac-only.ts')
})

it('offers no Host @ mentions without repository read access', async () => {
  const host = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!
  useRemoteLanesStore.setState({
    hosts: {
      [MOCK_HOST_ID]: {
        ...host,
        capabilities: host.capabilities.filter((c) => c !== 'workspaces.read'),
      },
    },
  })
  await render(<RemoteStartView hostId={MOCK_HOST_ID} machinePicker={machine} />)
  await type('@host')
  expect(repositoryFiles).not.toHaveBeenCalled()
  expect(el.textContent).not.toContain('src/host-only.ts')
})

// Regression: after Enter on a Host composer only the send button spun. The field
// stayed editable and looked idle, so an edit made then was silently not what was sent.
it('locks and marks the Host field busy while its lane is being created', async () => {
  await render(<RemoteStartView hostId={MOCK_HOST_ID} machinePicker={machine} />)
  await type('Fix the flaky test')
  const field = el.querySelector('textarea')!
  expect(field.matches(':disabled')).toBe(false)
  await act(async () =>
    useHomeSubmissionsStore.setState({ pending: { [`home:host:${MOCK_HOST_ID}/machine`]: true } }),
  )
  expect(field.matches(':disabled')).toBe(true)
  expect(field.closest('[aria-busy="true"]')).not.toBeNull()
  expect(field.value).toBe('Fix the flaky test')
})
