// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { it, expect, vi } from 'vitest'
import { TreeViewModal } from '@/features/sessions/TreeViewModal'
import type { SessionMeta } from '@shared/models'
import { useSessionsStore } from '@/stores/sessions'

it('forks an in-app tree node by file, refreshes the workspace and opens the created session', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const path = '/fixture/session',
    workspace = '/fixture',
    created = { path: '/fixture/copy' }
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'sessions:readTree')
      return {
        sessionId: 'pi',
        leafId: 'u',
        entries: [{ id: 'u', type: 'message', role: 'user', parentId: null, preview: 'hello' }],
      }
    if (channel === 'sessions:list') return [created]
    if (channel === 'sessions:forkAt') return created.path
    throw Error(channel)
  })
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  const refresh = vi.spyOn(useSessionsStore.getState(), 'refreshDisk').mockResolvedValue(undefined)
  const open = vi.spyOn(useSessionsStore.getState(), 'openDiskSession').mockResolvedValue('handle')
  const root = createRoot(document.createElement('div')),
    close = vi.fn()
  try {
    await act(async () =>
      root.render(
        <TreeViewModal meta={{ path } as SessionMeta} workspacePath={workspace} onClose={close} />,
      ),
    )
    act(() => {
      document
        .querySelector('[data-tooltip="Inspect tree node"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () =>
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent === 'Fork into new session')!
        .click(),
    )
    expect(invoke.mock.calls).toEqual([
      ['sessions:readTree', path],
      ['sessions:forkAt', path, 'u'],
      ['sessions:list', workspace],
    ])
    expect(refresh).toHaveBeenCalledWith(workspace)
    expect(open).toHaveBeenCalledWith(workspace, created)
    expect(close).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

it('offers Retry after a failed tree read instead of leaving the modal loading forever', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const invoke = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ sessionId: 's', leafId: null, entries: [] })
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () =>
      root.render(
        <TreeViewModal
          meta={{ path: '/fixture/session' }}
          workspacePath="/fixture"
          onClose={() => {}}
        />,
      ),
    )
    const retry = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry')
    expect(retry).toBeDefined()
    await act(async () => retry!.click())
    expect(document.body.textContent).toContain('0 nodes')
    expect(invoke).toHaveBeenCalledTimes(2)
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
