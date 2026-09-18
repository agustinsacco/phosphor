// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GitInfo } from '@shared/models'
import { useGitInfo } from './useGitInfo'

let root: Root
let container: HTMLDivElement
let latest: ReturnType<typeof useGitInfo>
let listener: (payload: { workspacePath: string; paths: string[] }) => void
const pending: Array<{ resolve: (info: GitInfo) => void; reject: (error: Error) => void }> = []
const invoke = vi.fn()
const unsubscribe = vi.fn()
const original = window.phosphor
function Probe({ path }: { path: string }): null {
  latest = useGitInfo(path)
  return null
}
function render(path: string): void {
  act(() => root.render(<Probe path={path} />))
}
async function finish(index: number, branch: string): Promise<void> {
  await act(async () => {
    pending[index]!.resolve({ isRepo: true, branch })
  })
}

beforeEach(() => {
  pending.length = 0
  invoke.mockReset().mockImplementation((channel: string) => {
    if (channel !== 'git:info') return Promise.resolve()
    return new Promise<GitInfo>((resolve, reject) => pending.push({ resolve, reject }))
  })
  unsubscribe.mockReset()
  window.phosphor = {
    invoke,
    onFsChanged: (cb: typeof listener) => {
      listener = cb
      return unsubscribe
    },
  } as unknown as typeof window.phosphor
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.phosphor = original
  vi.useRealTimers()
})

it('hides the previous workspace immediately and rejects its late response', async () => {
  render('/a')
  await finish(0, 'a')
  act(() => latest.refresh())
  render('/b')
  expect(latest.info).toBeNull()
  await finish(2, 'b')
  await finish(1, 'stale-a')
  expect(latest.info?.branch).toBe('b')
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})

it('forces focus refresh and ignores older responses in the same workspace', async () => {
  render('/a')
  act(() => window.dispatchEvent(new Event('focus')))
  expect(invoke).toHaveBeenLastCalledWith('git:info', '/a', { force: true })
  await finish(1, 'new')
  await finish(0, 'old')
  expect(latest.info?.branch).toBe('new')
})

it('debounces matching file events and cancels pending refresh on a workspace change', async () => {
  vi.useFakeTimers()
  render('/a')
  listener({ workspacePath: '/other', paths: [] })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
  expect(pending).toHaveLength(1)
  for (let i = 0; i < 20; i++) listener({ workspacePath: '/a', paths: [] })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
  expect(pending).toHaveLength(2)
  listener({ workspacePath: '/a', paths: [] })
  render('/b')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
  expect(pending).toHaveLength(3)
})

it('keeps a successful value on transient failure and can retry', async () => {
  render('/a')
  await finish(0, 'main')
  act(() => latest.refresh(true))
  await act(async () => {
    pending[1]!.reject(new Error('IPC unavailable'))
  })
  expect(latest.info?.branch).toBe('main')
  act(() => latest.refresh(true))
  await finish(2, 'updated')
  expect(latest.info?.branch).toBe('updated')
})

it('removes subscriptions, timers and focus listeners when unmounted', async () => {
  vi.useFakeTimers()
  render('/a')
  listener({ workspacePath: '/a', paths: [] })
  act(() => root.render(null))
  window.dispatchEvent(new Event('focus'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
  await finish(0, 'late')
  expect(pending).toHaveLength(1)
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})
