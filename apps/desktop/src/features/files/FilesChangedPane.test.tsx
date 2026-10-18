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

async function renderRevert(): Promise<HTMLButtonElement> {
  await act(async () => root.render(<FilesChangedPane workspacePath="/repo" />))
  return container.querySelector<HTMLButtonElement>('[aria-label="Revert nested/a.ts"]')!
}

async function dismissRevert(value: string | undefined): Promise<void> {
  const { usePromptStore } = await import('@/stores/prompt')
  await act(async () => {
    for (const request of usePromptStore.getState().requests)
      usePromptStore.getState().dismiss(request, value)
  })
}

it.each([undefined, 'not-revert'])(
  'queues revert and cancels without mutation for %s',
  async (choice) => {
    const { usePromptStore } = await import('@/stores/prompt')
    const button = await renderRevert()
    try {
      await act(async () => button.click())
      expect(invoke).not.toHaveBeenCalled()
      expect(usePromptStore.getState().requests).toHaveLength(1)
      expect(usePromptStore.getState().requests[0]).toMatchObject({
        kind: 'choice',
        choices: [expect.objectContaining({ value: 'revert' })],
      })
      await dismissRevert(choice)
      expect(invoke).not.toHaveBeenCalled()
    } finally {
      await dismissRevert(undefined)
    }
  },
)

it('refuses newly dirty buffers after the queued revert choice', async () => {
  const { usePromptStore } = await import('@/stores/prompt')
  await useFilesStore.getState().openFile('/repo', '/repo/nested/a.ts')
  const button = await renderRevert()
  invoke.mockClear()
  try {
    await act(async () => button.click())
    expect(invoke).not.toHaveBeenCalled()
    expect(usePromptStore.getState().requests).toHaveLength(1)
    useFilesStore.getState().updateBuffer('/repo', '/repo/nested/a.ts', 'unsaved')
    await dismissRevert('revert')
    expect(invoke).not.toHaveBeenCalled()
    expect(useExtensionUiStore.getState().pushToast).toHaveBeenCalledWith(
      expect.stringContaining('unsaved editor buffer'),
      'error',
    )
  } finally {
    await dismissRevert(undefined)
  }
})

it.each(['workspace', 'baseline'])(
  'does not revert if the %s changes while queued',
  async (change) => {
    const { usePromptStore } = await import('@/stores/prompt')
    const button = await renderRevert()
    try {
      await act(async () => button.click())
      expect(invoke).not.toHaveBeenCalled()
      expect(usePromptStore.getState().requests).toHaveLength(1)
      await act(async () => {
        if (change === 'workspace') root.render(<FilesChangedPane workspacePath="/other" />)
        else useSessionsStore.setState({ baselines: { session: 'new-baseline' } })
      })
      await dismissRevert('revert')
      expect(invoke).not.toHaveBeenCalled()
    } finally {
      await dismissRevert(undefined)
    }
  },
)

it('only reverts once on rapid clicks and remains disabled through mutation', async () => {
  const { usePromptStore } = await import('@/stores/prompt')
  const button = await renderRevert()
  let finish!: () => void
  invoke.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  try {
    await act(async () => {
      button.click()
      button.click()
    })
    expect(invoke).not.toHaveBeenCalled()
    expect(button.disabled).toBe(true)
    expect(usePromptStore.getState().requests).toHaveLength(1)
    await dismissRevert('revert')
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'git:restoreFileTo',
      '/repo',
      'baseline',
      'nested/a.ts',
    )
    expect(button.disabled).toBe(true)
    await act(async () => button.click())
    expect(invoke).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    expect(button.disabled).toBe(false)
  } finally {
    await dismissRevert(undefined)
    await act(async () => finish?.())
  }
})
