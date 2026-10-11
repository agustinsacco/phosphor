// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Terminal, ILinkHandler } from '@xterm/xterm'
import { installTerminalLinks } from './terminalLinks'

const web = vi.hoisted(() => ({
  activate: vi.fn(),
  hover: vi.fn(),
  leave: vi.fn(),
  dispose: vi.fn(),
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(activate: typeof web.activate, options: typeof web) {
      web.activate = activate
      web.hover = options.hover
      web.leave = options.leave
    }
    dispose = web.dispose
  },
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function setup(): {
  invoke: ReturnType<typeof vi.fn>
  handler: ILinkHandler
  container: HTMLElement
  dispose: () => void
} {
  const invoke = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('phosphor', { invoke })
  const term = { options: {}, loadAddon: vi.fn() } as unknown as Terminal
  const container = document.createElement('div')
  const links = installTerminalLinks(term, container)
  return { invoke, handler: term.options.linkHandler!, container, dispose: links.dispose }
}

const range = { start: { x: 1, y: 1 }, end: { x: 20, y: 1 } }

describe('terminal links', () => {
  for (const source of ['detected', 'OSC 8']) {
    it.each([{}, { ctrlKey: true }, { metaKey: true }])(
      `${source} opens once through IPC with modifiers %j`,
      (modifiers) => {
        const { invoke, handler, dispose } = setup()
        const event = new MouseEvent('mouseup', { ...modifiers, cancelable: true })
        const activate = source === 'detected' ? web.activate : handler.activate
        activate(event, 'http://localhost:3000/path?q=1', range)
        expect(invoke).toHaveBeenCalledExactlyOnceWith(
          'app:openExternal',
          'http://localhost:3000/path?q=1',
        )
        expect(event.defaultPrevented).toBe(true)
        dispose()
      },
    )

    it.each([1, 2])(`${source} does not open on mouse button %s`, (button) => {
      const { invoke, handler, dispose } = setup()
      const activate = source === 'detected' ? web.activate : handler.activate
      activate(new MouseEvent('mouseup', { button }), 'https://example.com', range)
      expect(invoke).not.toHaveBeenCalled()
      dispose()
    })
  }

  it('suppresses only Control-click context menus over links and removes its listener', () => {
    const { handler, container, dispose } = setup()
    const child = container.appendChild(document.createElement('div'))
    const menu = vi.fn()
    child.addEventListener('contextmenu', menu)
    const contextMenu = (ctrlKey: boolean): MouseEvent => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ctrlKey })
      child.dispatchEvent(event)
      return event
    }
    expect(contextMenu(true).defaultPrevented).toBe(false)
    web.hover()
    expect(contextMenu(true).defaultPrevented).toBe(true)
    expect(menu).toHaveBeenCalledTimes(1)
    expect(contextMenu(false).defaultPrevented).toBe(false)
    web.leave()
    expect(contextMenu(true).defaultPrevented).toBe(false)
    handler.hover!(new MouseEvent('mousemove'), 'https://example.com', range)
    expect(contextMenu(true).defaultPrevented).toBe(true)
    handler.leave!(new MouseEvent('mouseleave'), 'https://example.com', range)
    expect(contextMenu(true).defaultPrevented).toBe(false)
    web.hover()
    dispose()
    expect(contextMenu(true).defaultPrevented).toBe(false)
    expect(web.dispose).toHaveBeenCalledOnce()
  })
})
