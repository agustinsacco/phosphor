// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorktreeInfo } from '@shared/models'
import { useWorktreeDiscovery, type WorktreeDir } from './useWorktreeDiscovery'

let root: Root
let container: HTMLDivElement
const pending: Array<(worktrees: WorktreeInfo[]) => void> = []
const invoke = vi.fn()
const setDirs = vi.fn<(dirs: WorktreeDir[]) => void>()
const setSettled = vi.fn<(settled: boolean) => void>()
const original = window.phosphor

function Probe({ roots, refreshKey }: { roots: string[] | null; refreshKey: string }): null {
  useWorktreeDiscovery(roots, refreshKey, setDirs, setSettled)
  return null
}
function render(roots: string[] | null, refreshKey = ''): void {
  act(() => root.render(<Probe roots={roots} refreshKey={refreshKey} />))
}
function worktree(path: string, isMain = false): WorktreeInfo {
  return { path, branch: 'b', head: '0', isMain, locked: false, prunable: false } as WorktreeInfo
}
const lastSettled = (): boolean | undefined => setSettled.mock.calls.at(-1)?.[0]

beforeEach(() => {
  pending.length = 0
  invoke
    .mockReset()
    .mockImplementation(() => new Promise<WorktreeInfo[]>((resolve) => pending.push(resolve)))
  setDirs.mockReset()
  setSettled.mockReset()
  window.phosphor = { invoke } as unknown as typeof window.phosphor
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.phosphor = original
})

it('waits for hydrated roots before listing anything', () => {
  render(null)
  expect(invoke).not.toHaveBeenCalled()
  expect(setSettled).not.toHaveBeenCalled()
})

it('lists each root once and reports the non-main worktrees it found', async () => {
  render(['/repo'])
  await act(async () => pending[0]!([worktree('/repo', true), worktree('/repo-lane')]))
  expect(setDirs).toHaveBeenLastCalledWith([{ path: '/repo-lane', root: '/repo' }])
  expect(lastSettled()).toBe(true)
  // An equal roots array with a new identity is not a reason to list again.
  render(['/repo'])
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(lastSettled()).toBe(true)
})

it('re-lists when the refresh key moves', async () => {
  render(['/repo'], 'lanes:0')
  await act(async () => pending[0]!([]))
  render(['/repo'], 'lanes:1')
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(lastSettled()).toBe(false)
})

it('still settles when a listing is abandoned mid-flight for an equal set of roots', async () => {
  render(['/repo'])
  // The effect re-runs (roots re-derived) while the first listing is out:
  // that listing is cancelled, so the replacement must do the work itself.
  render(['/repo'])
  expect(invoke).toHaveBeenCalledTimes(2)
  await act(async () => {
    pending[0]!([worktree('/stale')])
    pending[1]!([worktree('/repo-lane')])
  })
  expect(setDirs).toHaveBeenCalledTimes(1)
  expect(setDirs).toHaveBeenLastCalledWith([{ path: '/repo-lane', root: '/repo' }])
  expect(lastSettled()).toBe(true)
})
