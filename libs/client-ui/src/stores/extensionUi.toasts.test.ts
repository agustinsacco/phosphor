import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_TOASTS, TOAST_EXIT_MS, useExtensionUiStore } from './extensionUi'

const store = () => useExtensionUiStore.getState()
const visible = () => store().toasts.filter((t) => !t.leaving)

beforeEach(() => {
  vi.useFakeTimers()
  useExtensionUiStore.setState({ toasts: [] })
})

afterEach(() => {
  store().setToastsPaused('hover', false)
  store().setToastsPaused('blur', false)
  vi.useRealTimers()
})

describe('toasts', () => {
  it('auto-dismisses through an exit phase before leaving the list', () => {
    store().pushToast('Saved')
    vi.advanceTimersByTime(5000)
    expect(store().toasts[0]?.leaving).toBe(true)
    vi.advanceTimersByTime(TOAST_EXIT_MS)
    expect(store().toasts).toHaveLength(0)
  })

  it('stacks newest first and caps what is on screen', () => {
    for (let i = 0; i < MAX_TOASTS + 2; i++) store().pushToast(`n${i}`)
    expect(visible().map((t) => t.message)).toEqual(['n5', 'n4', 'n3', 'n2'])
  })

  it('replaces a session notice in place and restarts its clock', () => {
    const first = store().notify({ message: 'working', sessionId: 's1', kind: 'success' })
    vi.advanceTimersByTime(4000)
    const second = store().notify({ message: 'done', sessionId: 's1', kind: 'success' })
    expect(second).toBe(first)
    expect(store().toasts).toHaveLength(1)
    expect(store().toasts[0]).toMatchObject({ message: 'done', bump: 1 })
    vi.advanceTimersByTime(4000)
    expect(store().toasts[0]?.leaving).toBe(false)
  })

  it('holds every clock while paused and resumes with the time that was left', () => {
    store().pushToast('Saved')
    vi.advanceTimersByTime(3000)
    store().setToastsPaused('blur', true)
    vi.advanceTimersByTime(60_000)
    expect(store().toasts[0]?.leaving).toBe(false)
    // Two reasons: releasing one still holds the clock.
    store().setToastsPaused('hover', true)
    store().setToastsPaused('blur', false)
    vi.advanceTimersByTime(60_000)
    expect(store().toasts[0]?.leaving).toBe(false)
    store().setToastsPaused('hover', false)
    vi.advanceTimersByTime(1999)
    expect(store().toasts[0]?.leaving).toBe(false)
    vi.advanceTimersByTime(1)
    expect(store().toasts[0]?.leaving).toBe(true)
  })

  it('a notice that arrives while paused waits for the pause to end', () => {
    store().setToastsPaused('blur', true)
    store().pushToast('Lane done')
    vi.advanceTimersByTime(60_000)
    expect(visible()).toHaveLength(1)
  })

  it('drops a session notice when the session goes', () => {
    store().notify({ message: 'done', sessionId: 's1' })
    store().pushToast('unrelated')
    store().clearSession('s1')
    expect(visible().map((t) => t.message)).toEqual(['unrelated'])
  })
})
