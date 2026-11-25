// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { ComposerInput } from './ComposerInput'
import { useSlashMenu, type SlashMenu } from './useSlashMenu'
import type { CommandEntry } from './commandCatalogue'

vi.mock('./ComposerField', () => ({ ComposerField: () => null }))
vi.mock('@/features/voice/DictateButton', () => ({ DictateButton: () => null }))
vi.mock('./SwarmSwitch', () => ({
  useSwarm: () => null,
  swarmLook: () => '',
  SwarmSwitch: () => null,
  SwarmControl: () => null,
}))

const ENTRIES: CommandEntry[] = [
  {
    name: 'whatsapp',
    description: 'Manage WhatsApp integration',
    badge: 'extension',
    origin: 'whatsapp-ng',
    aliases: [],
  },
]

let slash: SlashMenu | undefined
let root: Root
let container: HTMLDivElement

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  slash = undefined
})

/** The composer on its own, as every host screen mounts it: no wrapper of its own. */
function mount(): void {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('phosphor', { invoke: vi.fn(async () => []) })
  function Harness(): React.JSX.Element {
    slash = useSlashMenu({ entries: ENTRIES, setText: () => {}, focus: () => {} })
    return (
      <ComposerInput
        placeholder="Message"
        workspacePath="/mac"
        attachments={[]}
        onAttachmentsChange={() => {}}
        onWarning={() => {}}
        swarm={null}
        slash={slash}
        modelPicker={null}
        actions={null}
        value=""
        textareaRef={createRef()}
        onChange={() => {}}
        onSubmit={() => {}}
      />
    )
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() =>
    root.render(<PlatformProvider value={DESKTOP_PLATFORM}>{<Harness />}</PlatformProvider>),
  )
}

it('opens the / menu inside a box the composer owns, not one the screen lends', () => {
  mount()
  act(() => slash!.sync('/whats'))
  const menu = container.querySelector('[role=listbox]')!
  const card = container.querySelector('[data-testid="composer-toolbar"]')!
  // Both popups are `absolute bottom-full`, so each opens over the nearest
  // positioned ancestor. Walking up from the menu has to reach a positioned box
  // that already holds the input — the composer's own. Otherwise a screen that
  // wraps the composer in nothing (the Host home) makes the whole window the
  // anchor, and the menu lands over the title bar instead of the input.
  const anchor = positionedAncestor(menu.parentElement)!
  expect(anchor.contains(card)).toBe(true)
})

/** jsdom applies no stylesheets, so "positioned" is read off the class list. */
function positionedAncestor(node: HTMLElement | null): HTMLElement | null {
  for (let el = node; el; el = el.parentElement) {
    const classes = el.classList
    if (classes.contains('relative') || classes.contains('absolute') || classes.contains('fixed'))
      return el
  }
  return null
}
