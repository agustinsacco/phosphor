import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ExtensionUIRequest } from '@phosphor/shared/rpc'
import { createLaneProjection } from '@phosphor/session-runtime/lanes/projection'
import { createProjectionDialogs } from './dialogs'

function setup() {
  const projection = createLaneProjection({ now: Date.now, overflow: () => {} })
  const dialogs = createProjectionDialogs(projection)
  const resolve = vi.spyOn(projection, 'resolveDialog')
  function deliver(request: ExtensionUIRequest) {
    projection.apply({ kind: 'extension-ui', request })
    dialogs.deliver(request)
  }
  function ask(id: string, timeout?: number) {
    deliver({ type: 'extension_ui_request', id, method: 'input', title: 'Ask', timeout })
  }
  return { projection, dialogs, resolve, deliver, ask }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('arms unref timers only for dialogs accepted by the projection', () => {
  const { dialogs, ask, resolve } = setup()
  const scheduled = vi.spyOn(globalThis, 'setTimeout')
  dialogs.deliver({
    type: 'extension_ui_request',
    id: 'not-accepted',
    method: 'input',
    title: 'Rejected',
    timeout: 10,
  })
  expect(scheduled).not.toHaveBeenCalled()
  ask('accepted', 10)
  expect(scheduled.mock.results[0]?.value.hasRef()).toBe(false)
  vi.advanceTimersByTime(9)
  expect(resolve).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(resolve).toHaveBeenCalledExactlyOnceWith('accepted')
  expect(vi.getTimerCount()).toBe(0)
})

it('replaces a timeout without resolving its replacement at the old deadline', () => {
  const { ask, projection, resolve } = setup()
  ask('same', 10)
  vi.advanceTimersByTime(5)
  ask('same', 20)
  expect(vi.getTimerCount()).toBe(1)
  vi.advanceTimersByTime(5)
  expect(resolve).not.toHaveBeenCalled()
  expect(projection.view().dialogs).toHaveLength(1)
  vi.advanceTimersByTime(15)
  expect(resolve).toHaveBeenCalledExactlyOnceWith('same')
  expect(projection.view().dialogs).toEqual([])
})

it.each(['select', 'confirm', 'input', 'editor'] as const)(
  'cancels a timer when a %s replacement has no timeout',
  (method) => {
    const { ask, deliver, projection, resolve } = setup()
    ask('same', 10)
    const base = { type: 'extension_ui_request' as const, id: 'same', title: 'Replacement' }
    if (method === 'select') deliver({ ...base, method, options: ['one'] })
    else if (method === 'confirm') deliver({ ...base, method, message: 'Confirm?' })
    else deliver({ ...base, method })
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10)
    expect(resolve).not.toHaveBeenCalled()
    expect(projection.view().dialogs.map((d) => d.id)).toEqual(['same'])
  },
)

it('cancels answered dialogs independently and disposes all remaining timers idempotently', () => {
  const { ask, dialogs, resolve, projection } = setup()
  ask('a', 10)
  ask('b', 20)
  ask('c', 30)
  dialogs.resolve('a')
  expect(resolve).toHaveBeenCalledExactlyOnceWith('a')
  expect(projection.view().dialogs.map((d) => d.id)).toEqual(['b', 'c'])
  expect(vi.getTimerCount()).toBe(2)
  dialogs.dispose()
  dialogs.dispose()
  expect(vi.getTimerCount()).toBe(0)
  vi.advanceTimersByTime(30)
  expect(resolve).toHaveBeenCalledOnce()
})

it('rearms signed-int capped timeouts against the original absolute expiry', () => {
  const { ask, resolve, dialogs } = setup()
  const scheduled = vi.spyOn(globalThis, 'setTimeout')
  ask('long', 2 * (2 ** 31 - 1) + 5)
  vi.advanceTimersByTime(2 ** 31 - 1)
  vi.advanceTimersByTime(2 ** 31 - 1)
  expect(scheduled.mock.calls.map((c) => c[1])).toEqual([2 ** 31 - 1, 2 ** 31 - 1, 5])
  expect(scheduled.mock.results.every((r) => r.type === 'return' && !r.value.hasRef())).toBe(true)
  expect(resolve).not.toHaveBeenCalled()
  vi.advanceTimersByTime(5)
  expect(resolve).toHaveBeenCalledExactlyOnceWith('long')
  expect(vi.getTimerCount()).toBe(0)
  dialogs.dispose()
})
