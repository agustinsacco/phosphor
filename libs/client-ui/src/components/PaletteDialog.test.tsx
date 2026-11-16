// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TextInput } from './form'
import { PaletteDialog } from './PaletteDialog'
import {
  COMPACT_PLATFORM,
  DESKTOP_PLATFORM,
  PlatformProvider,
  WIDE_BROWSER_PLATFORM,
} from '@/platform/Platform'

let root: Root
let container: HTMLDivElement

function FocusFlow({ action }: { action: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState(false)
  return (
    <>
      <textarea aria-label="Composer" />
      <button onClick={() => setOpen(true)}>Open palette</button>
      {target && <TextInput autoFocus aria-label="Search settings" />}
      {open && (
        <PaletteDialog
          query=""
          onQuery={() => {}}
          matches={[{ id: 'settings', label: action, run: () => setTarget(true) }]}
          onRun={(item) => {
            setOpen(false)
            item.run()
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

for (const [name, platform] of [
  ['Desktop', DESKTOP_PLATFORM],
  ['wide browser', WIDE_BROWSER_PLATFORM],
  ['phone', COMPACT_PLATFORM],
] as const) {
  it.each(['Open settings', 'Keyboard shortcuts'])(`${name}: %s keeps its autofocus`, (action) => {
    act(() =>
      root.render(
        <PlatformProvider value={platform}>
          <FocusFlow action={action} />
        </PlatformProvider>,
      ),
    )
    container.querySelector('textarea')!.focus()
    act(() => container.querySelector('button')!.click())
    const input = document.querySelector<HTMLInputElement>('.palette-input')!
    expect(document.activeElement).toBe(input)
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
    })
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Search settings"]'))
  })

  it(`${name}: dismissing search returns focus to the composer`, () => {
    act(() =>
      root.render(
        <PlatformProvider value={platform}>
          <FocusFlow action="Open settings" />
        </PlatformProvider>,
      ),
    )
    const composer = container.querySelector('textarea')!
    composer.focus()
    act(() => container.querySelector('button')!.click())
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.activeElement).toBe(composer)
  })
}
