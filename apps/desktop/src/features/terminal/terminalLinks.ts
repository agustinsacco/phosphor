import type { Terminal, IDisposable } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'

/** Use the same external-browser path for detected URLs and OSC 8 hyperlinks. */
export function installTerminalLinks(term: Terminal, container: HTMLElement): IDisposable {
  let hoveringLink = false
  const activate = (event: MouseEvent, uri: string): void => {
    // xterm also calls activate for right/middle mouse releases.
    if (event.button !== 0) return
    event.preventDefault()
    void window.phosphor.invoke('app:openExternal', uri)
  }
  const hover = (): void => {
    hoveringLink = true
  }
  const leave = (): void => {
    hoveringLink = false
  }
  // Without this, OSC 8 uses confirm + window.open() with no URL. Main denies
  // that blank window, so xterm never gets to navigate it to the actual link.
  term.options.linkHandler = { activate, hover, leave }
  const webLinks = new WebLinksAddon(activate, { hover, leave })
  term.loadAddon(webLinks)

  const onContextMenu = (event: MouseEvent): void => {
    // macOS emits contextmenu on Control-click before mouseup. Keep it from
    // moving xterm's textarea under the pointer or opening our clipboard menu;
    // the normal link mouseup still owns activation, exactly once.
    if (event.ctrlKey && hoveringLink) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  container.addEventListener('contextmenu', onContextMenu, true)
  return {
    dispose: () => {
      container.removeEventListener('contextmenu', onContextMenu, true)
      webLinks.dispose()
      term.options.linkHandler = null
    },
  }
}
