import { describe, expect, it } from 'vitest'
import { drop, keyedSlice, keyedSliceFrom } from './keyedSlice'

interface Pane {
  pane: string | null
  tabs: string[]
}

const newSlice = (): ReturnType<typeof keyedSlice<Pane>> =>
  keyedSlice<Pane>({ pane: null, tabs: [] })

describe('keyedSlice — shared frozen empty', () => {
  it('hands every keyless reader the SAME object', () => {
    // The rule CLAUDE.md fact 5 states: a selector that allocated a fresh `{}`
    // per miss would make every subscriber re-render on every store change.
    const panes = newSlice()
    const map: Record<string, Pane> = {}

    expect(panes.read(map, 'a')).toBe(panes.read(map, 'b'))
    expect(panes.read(map, 'a')).toBe(panes.read({ other: { pane: 'x', tabs: [] } }, 'a'))
  })

  it('freezes the empty value, so a store that mutated it fails loudly', () => {
    const panes = newSlice()
    const empty = panes.read({}, 'missing')

    expect(Object.isFrozen(empty)).toBe(true)
  })

  it('reads a null or undefined key as absent', () => {
    // `sessionPanes` is called with the active session id, which is null on the
    // workspace home screen.
    const panes = newSlice()
    const map = { a: { pane: 'files', tabs: [] } }

    expect(panes.read(map, null).pane).toBeNull()
    expect(panes.read(map, undefined).pane).toBeNull()
    expect(panes.read(map, 'a').pane).toBe('files')
  })
})

describe('keyedSlice.patch', () => {
  it('creates the slice from the empty value on first write', () => {
    const panes = newSlice()

    const next = panes.patch({}, 'a', (current) => ({ ...current, pane: 'terminal' }))

    expect(next.a).toEqual({ pane: 'terminal', tabs: [] })
  })

  it('leaves the source map and the empty value untouched', () => {
    const panes = newSlice()
    const map: Record<string, Pane> = {}

    panes.patch(map, 'a', (current) => ({ ...current, pane: 'terminal' }))

    expect(map).toEqual({})
    expect(panes.read({}, 'a').pane).toBeNull()
  })

  it('keeps other keys by reference so their subscribers stay asleep', () => {
    const panes = newSlice()
    const other: Pane = { pane: 'files', tabs: [] }

    const next = panes.patch({ b: other }, 'a', (current) => ({ ...current, pane: 'terminal' }))

    expect(next.b).toBe(other)
  })
})

describe('keyedSliceFrom — fresh default per miss', () => {
  it('never shares the default between keys', () => {
    // Why chat.ts cannot use the frozen-singleton flavour: a `ChatSession`
    // carries the arrays the reducer appends to, so one shared default would
    // make every session render every other session's messages.
    const chats = keyedSliceFrom<Pane>(() => ({ pane: null, tabs: [] }))

    const withA = chats.patch({}, 'a', (session) => ({
      ...session,
      tabs: [...session.tabs, 'from-a'],
    }))
    const withBoth = chats.patch(withA, 'b', (session) => ({
      ...session,
      tabs: [...session.tabs, 'from-b'],
    }))

    expect(withBoth.a?.tabs).toEqual(['from-a'])
    expect(withBoth.b?.tabs).toEqual(['from-b'])
    expect(chats.read({}, 'c')).not.toBe(chats.read({}, 'c'))
  })
})

describe('drop', () => {
  it('returns a copy without the key', () => {
    const map = { a: 1, b: 2 }

    const next = drop(map, 'a')

    expect(next).toEqual({ b: 2 })
    expect(map).toEqual({ a: 1, b: 2 })
  })

  it('returns the SAME map when the key is absent', () => {
    // Store `remove` actions rely on this to keep state identity, which is what
    // lets them return the unchanged state instead of waking subscribers.
    const map = { a: 1 }

    expect(drop(map, 'never-existed')).toBe(map)
  })

  it('drops keys whose value is undefined', () => {
    // `artifacts.selected` is `Record<string, string | undefined>`, so a
    // value-based check (`if (!map[key]) return map`) would leak those entries.
    const map: Record<string, string | undefined> = { a: undefined, b: 'x' }

    expect(drop(map, 'a')).toEqual({ b: 'x' })
    expect('a' in drop(map, 'a')).toBe(false)
  })
})
