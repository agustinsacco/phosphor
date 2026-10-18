import { beforeEach, describe, expect, it } from 'vitest'
import { isNaming, isNamingInWorkspace, useNamingStore } from '@/stores/naming'

/**
 * The hooks in nameTransition.ts are thin wrappers over these (the repo has no
 * react testing library and prefers extracted logic to component tests — see
 * CLAUDE.md), so this covers the parts with decisions in them: the store
 * reducer and the two predicates the sidebar and branch chip read.
 */

beforeEach(() => {
  useNamingStore.setState({ naming: {} })
})

describe('useNamingStore', () => {
  it('records a chat as being named, then clears it', () => {
    const store = useNamingStore.getState()
    store.start('s1', '/repo/wt-a')
    expect(useNamingStore.getState().naming).toEqual({ s1: '/repo/wt-a' })
    store.finish('s1')
    // Dropped, not tombstoned: read per row on every render.
    expect(useNamingStore.getState().naming).toEqual({})
  })

  it('keeps concurrent chats independent', () => {
    const store = useNamingStore.getState()
    store.start('s1', '/repo/wt-a')
    store.start('s2', '/repo/wt-b')
    store.finish('s1')
    expect(useNamingStore.getState().naming).toEqual({ s2: '/repo/wt-b' })
  })

  it('finishing an unknown chat leaves state identical, not merely equal', () => {
    const before = useNamingStore.getState().naming
    useNamingStore.getState().finish('never-started')
    // Same reference, so subscribers are not woken for a no-op — this store
    // exists precisely to avoid gratuitous re-renders.
    expect(useNamingStore.getState().naming).toBe(before)
  })
})

describe('isNaming', () => {
  it('answers per session, and is false for a row with no live session', () => {
    const naming = { s1: '/repo/wt-a' }
    expect(isNaming(naming, 's1')).toBe(true)
    expect(isNaming(naming, 's2')).toBe(false)
    expect(isNaming(naming, undefined)).toBe(false)
  })
})

describe('isNamingInWorkspace', () => {
  it('only reports the folder whose own chat is being named', () => {
    const naming = { s1: '/repo/wt-a' }
    expect(isNamingInWorkspace(naming, '/repo/wt-a')).toBe(true)
    // A sibling worktree's branch is not about to be renamed, so its chip must
    // not shimmer — this is the whole point of scoping by folder.
    expect(isNamingInWorkspace(naming, '/repo/wt-b')).toBe(false)
  })

  it('is false when nothing is being named', () => {
    expect(isNamingInWorkspace({}, '/repo/wt-a')).toBe(false)
  })
})
