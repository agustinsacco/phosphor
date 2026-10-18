// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { useFilesStore } from '@/stores/files'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { FilesChangedPane } from './FilesChangedPane'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('./MonacoEditor', () => ({ MonacoDiff: () => null }))
const invoke = vi.fn()
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  invoke.mockReset().mockResolvedValue({ content: 'disk', size: 4, mtimeMs: 1 })
  Object.assign(window, { phosphor: { invoke } })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(useExtensionUiStore.getState(), 'pushToast')
  useFilesStore.setState({ byWorkspace: {} })
  useSessionsStore.setState({ activeSessionId: 'session', baselines: { session: 'baseline' } })
  useChatStore.setState({ sessions: {} })
  useChatStore.getState().ensure('session')
  useChatStore.setState((s) => ({
    sessions: {
      session: {
        ...s.sessions.session!,
        tools: {
          edit: {
            toolCallId: 'edit',
            toolName: 'edit',
            args: { path: 'nested/a.ts' },
            argsText: '',
            status: 'done',
            output: null,
          },
        },
      },
    },
  }))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

it.each([
  { workspace: '/repo', path: '/repo/nested/a.ts' },
  { workspace: 'C:\\repo', path: 'C:\\repo\\nested\\a.ts' },
  { workspace: 'C:\\repo', path: 'C:/repo/nested/a.ts' },
])('blocks revert of an unsaved buffer at $path', async ({ workspace, path }) => {
  await useFilesStore.getState().openFile(workspace, path)
  useFilesStore.getState().updateBuffer(workspace, path, 'unsaved')
  await act(async () => root.render(<FilesChangedPane workspacePath={workspace} />))
  invoke.mockClear()
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Revert nested/a.ts"]')!.click(),
  )
  expect(invoke).not.toHaveBeenCalled()
  expect(window.confirm).not.toHaveBeenCalled()
  expect(useExtensionUiStore.getState().pushToast).toHaveBeenCalledWith(
    expect.stringContaining('unsaved editor buffer'),
    'error',
  )
})

it('allows a clean buffer to revert after confirmation', async () => {
  await useFilesStore.getState().openFile('/repo', '/repo/nested/a.ts')
  await act(async () => root.render(<FilesChangedPane workspacePath="/repo" />))
  invoke.mockClear()
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Revert nested/a.ts"]')!.click(),
  )
  expect(invoke).toHaveBeenCalledWith('git:restoreFileTo', '/repo', 'baseline', 'nested/a.ts')
})

it('characterizes reverse-patch revert without a saved baseline', async () => {
  const { usePromptStore } = await import('@/stores/prompt')
  const unsubscribe = usePromptStore.subscribe((state) => {
    for (const request of state.requests) usePromptStore.getState().dismiss(request, 'revert')
  })
  useSessionsStore.setState({ baselines: {} })
  useChatStore.setState((state) => ({
    sessions: {
      session: {
        ...state.sessions.session!,
        tools: {
          edit: {
            ...state.sessions.session!.tools.edit!,
            output: { content: [], details: { patch: '@@ -1 +1 @@\n-old\n+disk' } },
          },
        },
      },
    },
  }))
  try {
    await act(async () => root.render(<FilesChangedPane workspacePath="/repo" />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Revert nested/a.ts"]')!.click(),
    )
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['fs:readFile', 'fs:writeFile'])
    expect(invoke).toHaveBeenLastCalledWith('fs:writeFile', '/repo/nested/a.ts', 'old')
  } finally {
    unsubscribe()
  }
})
