import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acknowledgeToast, TOAST_EXIT_MS, useExtensionUiStore } from './extensionUi'
import {
  MAX_NOTIFICATIONS,
  NEW_TTL_MS,
  SEEN_TTL_MS,
  unseenCount,
  useNotificationsStore,
} from './notifications'

const inbox = () => useNotificationsStore.getState()
const toasts = () => useExtensionUiStore.getState()

beforeEach(() => {
  vi.useFakeTimers()
  useNotificationsStore.setState({ items: [], open: false })
  useExtensionUiStore.setState({ toasts: [] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('notification inbox', () => {
  it('keeps lane notices and problems, not one-line confirmations', () => {
    toasts().pushToast('Copied')
    toasts().pushToast('Could not save', 'error')
    toasts().notify({ message: 'Finished.', kind: 'success', sessionId: 's1', title: 'Lane' })
    expect(inbox().items.map((item) => item.message)).toEqual(['Finished.', 'Could not save'])
    expect(unseenCount(inbox())).toBe(2)
  })

  it('holds one entry per lane, new again and on top when it updates', () => {
    toasts().notify({ message: 'Started', sessionId: 's1' })
    toasts().pushToast('Disk full', 'error')
    inbox().markSeen()
    toasts().notify({ message: 'Finished.', kind: 'success', sessionId: 's1' })
    expect(inbox().items.map((item) => [item.message, !!item.seenAt])).toEqual([
      ['Finished.', false],
      ['Disk full', true],
    ])
  })

  it('stays new when its toast times out, and is seen once dismissed or opened', () => {
    toasts().pushToast('Timed out', 'error')
    vi.advanceTimersByTime(9000 + TOAST_EXIT_MS)
    expect(toasts().toasts).toHaveLength(0)
    expect(inbox().items[0]?.seenAt).toBeUndefined()

    toasts().notify({ message: 'Dismissed', kind: 'warning' })
    acknowledgeToast(toasts().toasts[0]!)
    expect(inbox().items[0]).toMatchObject({ message: 'Dismissed', seenAt: expect.any(Number) })
  })

  it('is seen when you go to its lane, and gone when the lane closes', () => {
    toasts().notify({ message: 'Finished.', sessionId: 's1' })
    toasts().dismissSessionToast('s1')
    expect(unseenCount(inbox())).toBe(0)
    toasts().clearSession('s1')
    expect(inbox().items).toHaveLength(0)
  })

  it('lands in the open drawer instead of toasting, and closing it marks all seen', () => {
    inbox().setOpen(true)
    toasts().notify({ message: 'Finished.', sessionId: 's1' })
    toasts().pushToast('Copied')
    expect(toasts().toasts.map((toast) => toast.message)).toEqual(['Copied'])
    expect(unseenCount(inbox())).toBe(1)
    inbox().setOpen(false)
    expect(unseenCount(inbox())).toBe(0)
  })

  it('ages out seen notices after a day and new ones after three', () => {
    toasts().pushToast('old seen', 'error')
    toasts().pushToast('old new', 'error')
    inbox().markSeen([inbox().items[1]!.id])
    vi.advanceTimersByTime(SEEN_TTL_MS)
    inbox().prune()
    expect(inbox().items.map((item) => item.message)).toEqual(['old new'])
    vi.advanceTimersByTime(NEW_TTL_MS - SEEN_TTL_MS)
    inbox().prune()
    expect(inbox().items).toHaveLength(0)
  })

  it('caps the list, dropping the oldest', () => {
    for (let i = 0; i <= MAX_NOTIFICATIONS; i++) toasts().pushToast(`n${i}`, 'error')
    expect(inbox().items).toHaveLength(MAX_NOTIFICATIONS)
    expect(inbox().items.at(-1)?.message).toBe('n1')
  })

  it('removes one entry, or clears everything seen', () => {
    toasts().pushToast('a', 'error')
    toasts().pushToast('b', 'error')
    toasts().pushToast('c', 'error')
    inbox().remove(inbox().items[0]!.id)
    inbox().markSeen([inbox().items[0]!.id])
    inbox().clearSeen()
    expect(inbox().items.map((item) => item.message)).toEqual(['a'])
  })
})
