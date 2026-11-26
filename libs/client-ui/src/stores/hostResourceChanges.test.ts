import { afterEach, expect, it, vi } from 'vitest'
import type { HostResourceChangedEvent } from '@shared/ipc'
import { attachHostResourceChanges, useHostResourceChanges } from './hostResourceChanges'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('coalesces only matching machines and kinds and cancels queued notifications on detach', () => {
  vi.useFakeTimers()
  let emit: (event: HostResourceChangedEvent) => void = () => {}
  const unsubscribe = vi.fn()
  vi.stubGlobal('window', {
    phosphor: {
      onHostResourceChanged: (listener: typeof emit) => {
        emit = listener
        return unsubscribe
      },
    },
  })
  const stop = attachHostResourceChanges()
  emit({ hostId: 'a', kind: 'archives' })
  emit({ hostId: 'a', kind: 'archives' })
  emit({ hostId: 'b', kind: 'archives' })
  emit({ hostId: 'a', kind: 'connectors' })
  expect(useHostResourceChanges.getState()).toEqual({})
  vi.advanceTimersByTime(100)
  expect(useHostResourceChanges.getState()).toEqual({
    'a:archives': 1,
    'b:archives': 1,
    'a:connectors': 1,
    '*:archives': 2,
    '*:connectors': 1,
  })
  emit({ hostId: 'b', kind: 'settings' })
  stop()
  vi.advanceTimersByTime(100)
  expect(useHostResourceChanges.getState()['b:settings']).toBeUndefined()
  expect(unsubscribe).toHaveBeenCalledOnce()
})
