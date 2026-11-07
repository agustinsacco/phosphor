// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useLaneMoveStore } from '@/stores/laneMove'
import { LaneMoveHost } from './LaneMoveModal'

const remote = vi.hoisted(() => ({ hosts: {} }))
vi.mock('@/stores/remoteLanes', () => ({
  machineLabel: () => 'Host',
  navigateToLane: vi.fn(),
  useRemoteLanesStore: (select: (s: unknown) => unknown) => select(remote),
}))
const folders = vi.hoisted(() => ({
  recents: [{ path: '/target', name: 'Target' }],
  sandboxes: [],
}))
vi.mock('@/stores/workspaces', () => ({
  useWorkspacesStore: (select: (s: unknown) => unknown) => select(folders),
}))
vi.mock('@/stores/sessions', () => ({ useSessionsStore: { getState: vi.fn() } }))

let root: Root | undefined
let el: HTMLDivElement | undefined
afterEach(() => {
  if (root) act(() => root!.unmount())
  el?.remove()
  useLaneMoveStore.getState().close()
  vi.unstubAllGlobals()
})

it('recovers from a failed first check and requires acknowledgement before Move', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const invoke = vi.fn().mockRejectedValueOnce(new Error('Connection changed.')).mockResolvedValue({
    mode: 'folder',
    branch: null,
    workspace: 'Target',
    blockers: [],
    bytes: 10,
  })
  vi.stubGlobal('phosphor', { invoke })
  useLaneMoveStore.getState().open({
    source: { machine: 'local', sessionPath: '/source.jsonl' },
    title: 'Research',
    marks: { pinned: false, marker: null },
  })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  await act(async () => root!.render(<LaneMoveHost />))
  const select = document.querySelector('select[aria-label="Workspace"]') as HTMLSelectElement
  await act(async () => {
    select.value = 'local:/target'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(document.body.textContent).toContain('Connection changed.')
  const buttons = () => Array.from(document.querySelectorAll('button'))
  await act(async () =>
    buttons()
      .find((b) => b.textContent === 'Retry check')!
      .click(),
  )
  expect(document.body.textContent).not.toContain('Connection changed.')
  const move = buttons().find((b) => b.textContent === 'Move')!
  expect(move.disabled).toBe(true)
  await act(async () =>
    (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
  )
  expect(move.disabled).toBe(false)
  expect(invoke).toHaveBeenCalledTimes(2)
})
