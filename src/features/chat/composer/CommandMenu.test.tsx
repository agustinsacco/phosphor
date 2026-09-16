// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CommandMenu, buildCommandEntries, filterCommandEntries } from './CommandMenu'
import { REAL_PI_COMMANDS } from './__fixtures__/piCommands'

let root: Root | null = null
let container: HTMLDivElement | null = null

// jsdom has no layout, so the active row's scroll-into-view is a no-op here.
Element.prototype.scrollIntoView = () => {}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

function render(element: React.JSX.Element): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(element))
  return container
}

const ENTRIES = buildCommandEntries(REAL_PI_COMMANDS, [
  { name: 'compact', description: 'Compact conversation context now', run: () => {} },
])

const noop = (): void => {}

describe('CommandMenu', () => {
  it('renders exactly the entries it is given — every one, in that order', () => {
    const rows = filterCommandEntries('', ENTRIES)
    const el = render(
      <CommandMenu
        query=""
        entries={rows}
        activeIndex={0}
        onHover={noop}
        onPick={noop}
        onClose={noop}
      />,
    )
    const rendered = [...el.querySelectorAll('[data-testid="command-menu-row"]')].map(
      (row) => row.querySelector('span')!.textContent,
    )
    expect(rendered).toEqual(rows.map((r) => `/${r.name}`))
    // The seventeenth row exists: the list used to stop at twelve.
    expect(rendered.length).toBeGreaterThan(12)
    expect(rendered).toContain('/skill:debug')
  })

  it('shows section headers while browsing and none while searching', () => {
    const browse = render(
      <CommandMenu
        query=""
        entries={filterCommandEntries('', ENTRIES)}
        activeIndex={0}
        onHover={noop}
        onPick={noop}
        onClose={noop}
      />,
    )
    const headers = [...browse.querySelectorAll('[role="presentation"]')].map((h) => h.textContent)
    expect(headers).toEqual(['Phosphor', 'Extensions', 'Prompts', 'Skills'])

    act(() => root?.unmount())
    container?.remove()
    const search = render(
      <CommandMenu
        query="mcp"
        entries={filterCommandEntries('mcp', ENTRIES)}
        activeIndex={0}
        onHover={noop}
        onPick={noop}
        onClose={noop}
      />,
    )
    expect(search.querySelectorAll('[role="presentation"]')).toHaveLength(0)
  })

  it('is a listbox whose active option is the highlighted row', () => {
    const rows = filterCommandEntries('', ENTRIES)
    const el = render(
      <CommandMenu
        query=""
        entries={rows}
        activeIndex={2}
        listboxId="menu"
        onHover={noop}
        onPick={noop}
        onClose={noop}
      />,
    )
    const listbox = el.querySelector('[role="listbox"]')!
    expect(listbox.getAttribute('aria-activedescendant')).toBe('menu-option-2')
    const options = el.querySelectorAll('[role="option"]')
    expect(options).toHaveLength(rows.length)
    expect(options[2]!.getAttribute('aria-selected')).toBe('true')
    expect(options[1]!.getAttribute('aria-selected')).toBe('false')
  })

  it('puts the origin and the full tooltip on every row', () => {
    const rows = filterCommandEntries('websearch', ENTRIES)
    const el = render(
      <CommandMenu
        query="websearch"
        entries={rows}
        activeIndex={0}
        onHover={noop}
        onPick={noop}
        onClose={noop}
      />,
    )
    const row = el.querySelector('[data-testid="command-menu-row"]')!
    expect(row.textContent).toContain('pi-web-access')
    expect(row.getAttribute('title')).toContain('From: pi-web-access')
    expect(row.getAttribute('title')).toContain('/pi-web-access/index.ts')
  })

  it('picks the row that was clicked', () => {
    const rows = filterCommandEntries('', ENTRIES)
    const onPick = vi.fn()
    const el = render(
      <CommandMenu
        query=""
        entries={rows}
        activeIndex={0}
        onHover={noop}
        onPick={onPick}
        onClose={noop}
      />,
    )
    const last = el.querySelectorAll('[data-testid="command-menu-row"]')
    act(() => (last[last.length - 1] as HTMLButtonElement).click())
    expect(onPick).toHaveBeenCalledWith(rows[rows.length - 1])
  })

  describe('with nothing to list', () => {
    const empty = (props: {
      query: string
      status?: 'loading' | 'error' | 'ready'
      errorMessage?: string
    }) =>
      render(
        <CommandMenu
          entries={[]}
          activeIndex={0}
          onHover={noop}
          onPick={noop}
          onClose={noop}
          {...props}
        />,
      ).querySelector('[data-testid="command-menu-empty"]')!.textContent

    it('says it is loading', () => {
      expect(empty({ query: '', status: 'loading' })).toBe('Loading commands…')
    })

    it('says pi could not be asked, with the reason', () => {
      expect(empty({ query: '', status: 'error', errorMessage: 'pi is not installed' })).toBe(
        "Couldn't list commands — pi is not installed",
      )
    })

    it('says nothing matched and what Enter will do', () => {
      expect(empty({ query: 'zzz' })).toBe(
        'No command matches /zzz — Enter sends it to pi as a prompt',
      )
    })

    it('says there is nothing at all', () => {
      expect(empty({ query: '' })).toBe('No commands available')
    })
  })
})
