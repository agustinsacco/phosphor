// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { slashQuery, useSlashMenu, type SlashMenu } from './useSlashMenu'
import { buildCommandEntries, type CommandEntry } from './commandCatalogue'
import { REAL_PI_COMMANDS } from './__fixtures__/piCommands'

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

const ENTRIES = buildCommandEntries(
  [
    { name: 'review', description: 'Review the diff', source: 'skill' },
    { name: 'refactor', description: 'Clean up', source: 'prompt' },
  ],
  [],
)

/** What a live session with the real payload offers: 3 native + 17 pi rows. */
const SESSION_ENTRIES = buildCommandEntries(REAL_PI_COMMANDS, [
  { name: 'compact', description: 'Compact conversation context now', run: () => {} },
  { name: 'export', description: 'Export this session as HTML', run: () => {} },
  { name: 'name', description: 'Rename this session', run: () => {} },
])

/** Mount the hook and hand back the latest value plus the spies it was given. */
function mount(entries: CommandEntry[] = ENTRIES): {
  menu: () => SlashMenu
  setText: ReturnType<typeof vi.fn>
  onOpen: ReturnType<typeof vi.fn>
} {
  const setText = vi.fn()
  const onOpen = vi.fn()
  let latest: SlashMenu | null = null

  function Harness(): React.JSX.Element {
    latest = useSlashMenu({ entries, setText, onOpen })
    return <div />
  }

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<Harness />))
  return { menu: () => latest!, setText, onOpen }
}

/** A keydown event shaped like the ones ComposerField forwards. */
function key(name: string, shiftKey = false): React.KeyboardEvent<HTMLTextAreaElement> {
  return {
    key: name,
    shiftKey,
    preventDefault: vi.fn(),
  } as unknown as React.KeyboardEvent<HTMLTextAreaElement>
}

describe('slashQuery', () => {
  it('opens on a leading slash and reports what follows', () => {
    expect(slashQuery('/rev')).toBe('rev')
    expect(slashQuery('/')).toBe('')
  })

  it('stays closed for a slash that is not the whole value', () => {
    // A path, not a command.
    expect(slashQuery('look at src/lib')).toBeNull()
    // The space means the command is chosen and arguments are being typed.
    expect(slashQuery('/review src')).toBeNull()
    expect(slashQuery('')).toBeNull()
  })
})

describe('useSlashMenu', () => {
  it('is closed until the value syncs a query, and loads its list once open', () => {
    const { menu, onOpen } = mount()
    expect(menu().visible).toBe(false)

    act(() => menu().sync('/re'))
    expect(menu().visible).toBe(true)
    expect(menu().matches.map((entry) => entry.name)).toEqual(['review', 'refactor'])
    expect(onOpen).toHaveBeenCalled()

    act(() => menu().sync('hello'))
    expect(menu().visible).toBe(false)
  })

  it('stays open with no matches so the empty row can say why, but does not swallow Enter', () => {
    const { menu, setText } = mount()
    act(() => menu().sync('/zzz'))
    expect(menu().query).toBe('zzz')
    expect(menu().visible).toBe(true)
    expect(menu().matches).toEqual([])
    // Enter goes to the composer — `/zzz` is a prompt pi accepts.
    expect(menu().handleKeyDown(key('Enter'))).toBe(false)
    expect(menu().handleKeyDown(key('Tab'))).toBe(false)
    expect(menu().handleKeyDown(key('ArrowDown'))).toBe(false)
    expect(setText).not.toHaveBeenCalled()
    // Escape still dismisses it.
    act(() => void menu().handleKeyDown(key('Escape')))
    expect(menu().visible).toBe(false)
  })

  it('is open, with the full list, the moment `/` is typed', () => {
    const { menu } = mount(SESSION_ENTRIES)
    act(() => menu().sync('/'))
    expect(menu().visible).toBe(true)
    // 3 native + 18 pi − 1 folded alias − 1 demoted = 19 rows; not 12.
    expect(menu().matches).toHaveLength(19)
    expect(menu().matches.filter((m) => m.badge === 'skill')).toHaveLength(7)
  })

  it('wraps arrow navigation and consumes the keys', () => {
    const { menu } = mount()
    act(() => menu().sync('/re'))

    act(() => void menu().handleKeyDown(key('ArrowDown')))
    expect(menu().activeIndex).toBe(1)
    act(() => void menu().handleKeyDown(key('ArrowDown')))
    expect(menu().activeIndex).toBe(0)
    act(() => void menu().handleKeyDown(key('ArrowUp')))
    expect(menu().activeIndex).toBe(1)
  })

  it('can walk past the twelfth row and pick what is highlighted there', () => {
    const { menu, setText } = mount(SESSION_ENTRIES)
    act(() => menu().sync('/'))
    for (let i = 0; i < 13; i++) act(() => void menu().handleKeyDown(key('ArrowDown')))
    expect(menu().activeIndex).toBe(13)
    const highlighted = menu().matches[13]!
    expect(highlighted.badge).toBe('skill')
    act(() => void menu().handleKeyDown(key('Enter')))
    // The picked row IS the highlighted row — one array, not two filters.
    expect(setText).toHaveBeenCalledWith(`/${highlighted.name} `)
  })

  it('prefills "/name " on Enter so arguments can follow', () => {
    const { menu, setText } = mount()
    act(() => menu().sync('/re'))
    act(() => void menu().handleKeyDown(key('Enter')))

    expect(setText).toHaveBeenCalledWith('/review ')
    expect(menu().visible).toBe(false)
  })

  it('leaves Shift+Enter alone', () => {
    const { menu, setText } = mount()
    act(() => menu().sync('/re'))
    expect(menu().handleKeyDown(key('Enter', true))).toBe(false)
    expect(setText).not.toHaveBeenCalled()
  })

  it('runs a native command and clears the composer instead of prefilling', () => {
    const run = vi.fn()
    const entries = buildCommandEntries([], [{ name: 'compact', description: 'Compact', run }])
    const { menu, setText } = mount(entries)
    act(() => menu().sync('/comp'))
    act(() => void menu().handleKeyDown(key('Tab')))

    expect(run).toHaveBeenCalled()
    expect(setText).toHaveBeenCalledWith('')
  })

  it('closes on Escape without touching the text', () => {
    const { menu, setText } = mount()
    act(() => menu().sync('/re'))
    act(() => void menu().handleKeyDown(key('Escape')))

    expect(menu().visible).toBe(false)
    expect(setText).not.toHaveBeenCalled()
  })

  it('resets the highlight when the query changes', () => {
    const { menu } = mount(SESSION_ENTRIES)
    act(() => menu().sync('/'))
    act(() => void menu().handleKeyDown(key('ArrowDown')))
    expect(menu().activeIndex).toBe(1)
    act(() => menu().sync('/m'))
    expect(menu().activeIndex).toBe(0)
  })
})
