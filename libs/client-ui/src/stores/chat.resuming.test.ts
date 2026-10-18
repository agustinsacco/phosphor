import { beforeEach, describe, expect, it } from 'vitest'
import { useChatStore } from './chat'

/**
 * The `resuming` flag gates the transcript skeleton. If it ever fails to
 * clear, a session sits behind placeholder bars forever, so every exit path
 * is pinned here.
 */
describe('chat store resuming flag', () => {
  beforeEach(() => {
    useChatStore.setState({ sessions: {} })
  })

  const session = (id: string) => {
    const found = useChatStore.getState().sessions[id]
    if (!found) throw new Error(`no chat session ${id}`)
    return found
  }

  it('is off for a fresh session, so it shows the empty state not a skeleton', () => {
    useChatStore.getState().ensure('new')
    expect(session('new').resuming).toBe(false)
  })

  it('is on when opening a session that has history on disk', () => {
    useChatStore.getState().ensure('resumed', { resuming: true })
    expect(session('resumed').resuming).toBe(true)
  })

  it('clears once history is hydrated', () => {
    useChatStore.getState().ensure('resumed', { resuming: true })
    useChatStore.getState().hydrate('resumed', [])
    expect(session('resumed').resuming).toBe(false)
  })

  it('clears on doneResuming, the path taken when get_messages fails', () => {
    useChatStore.getState().ensure('resumed', { resuming: true })
    useChatStore.getState().doneResuming('resumed')
    expect(session('resumed').resuming).toBe(false)
  })

  it('clears when the session errors — history is never arriving', () => {
    useChatStore.getState().ensure('resumed', { resuming: true })
    useChatStore.getState().setError('resumed', 'pi exited')
    expect(session('resumed').resuming).toBe(false)
  })

  it('does not re-arm the flag when ensure is called again for a live session', () => {
    useChatStore.getState().ensure('resumed', { resuming: true })
    useChatStore.getState().hydrate('resumed', [])
    useChatStore.getState().ensure('resumed', { resuming: true })
    expect(session('resumed').resuming).toBe(false)
  })

  it('leaves other sessions untouched', () => {
    useChatStore.getState().ensure('a', { resuming: true })
    useChatStore.getState().ensure('b', { resuming: true })
    useChatStore.getState().doneResuming('a')
    expect(session('a').resuming).toBe(false)
    expect(session('b').resuming).toBe(true)
  })
})
