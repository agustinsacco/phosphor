import { TooltipButton } from '@/components/Tooltip'
import { memo, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalStore } from '@/stores/terminal'
import { showContextMenu } from '@/components/ContextMenu'
import { formatShortcut, hostPlatform } from '@/lib/shortcuts'
import { clipboardActionFor, clipboardModifiers } from './clipboardKeys'
import { xtermTheme } from './xtermTheme'
import { installTerminalLinks } from './terminalLinks'

/** Copy the current selection, then hand focus back to the shell. */
function copySelection(term: Terminal): void {
  const selection = term.getSelection()
  if (!selection) return
  void navigator.clipboard.writeText(selection)
  term.clearSelection()
  term.focus()
}

/** Paste through xterm so bracketed-paste mode is honoured. */
function pasteFromClipboard(term: Terminal): void {
  term.focus()
  void navigator.clipboard.readText().then((text) => {
    if (text) term.paste(text)
  })
}

/** One xterm instance bound to a main-process PTY. */
export const TerminalView = memo(function TerminalView({
  ptyId,
  visible,
}: {
  ptyId: string
  visible: boolean
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme)
  const fonts = useSettingsStore((s) => s.fonts)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const pendingPaste = useTerminalStore((s) => s.pendingPaste)
  const [ready, setReady] = useState(false)
  const [stagedCommand, setStagedCommand] = useState<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const initialFonts = useSettingsStore.getState().fonts
    const term = new Terminal({
      fontFamily: `${initialFonts.monoFont}, ui-monospace, SF Mono, Menlo, monospace`,
      fontSize: initialFonts.terminalFontSize,
      lineHeight: 1.25,
      scrollback: 10_000,
      cursorBlink: true,
      allowProposedApi: true,
      theme: xtermTheme(useSettingsStore.getState().resolvedTheme),
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    const links = installTerminalLinks(term, container)
    term.open(container)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    // Renderer → PTY
    const dataDisposable = term.onData((data) => {
      void window.phosphor.invoke('pty:write', ptyId, data)
    })

    /*
     * PTY → renderer, with a replay for reattach.
     *
     * Closing the terminal pane unmounts every view and disposes its xterm,
     * but the PTY keeps running (that is the point — your build survives).
     * A fresh xterm therefore starts blank in front of a live shell, which
     * reads as "the terminal is broken": no prompt, no history, and the shell
     * has no reason to redraw until you press a key.
     *
     * So: ignore live chunks until main replies with its scrollback, then
     * write that snapshot. Main appends to its scrollback before broadcasting,
     * so anything received during the round trip is already contained in the
     * snapshot; ignoring it is what makes this exact rather
     * than "replay and hope". Chunks that arrive after the snapshot are sent
     * after main replied, and IPC delivery is ordered, so they land in
     * `live` mode and stream straight through.
     */
    setReady(false)
    let replayed = false
    const writeOutput = (data: string): void => {
      // xterm parses writes asynchronously. Paste only after the shell's output
      // has been parsed, including its bracketed-paste mode, not just attached.
      term.write(data, () => {
        if (termRef.current === term) setReady(true)
      })
    }
    const unsubscribeData = window.phosphor.onPtyData(ptyId, (data) => {
      if (replayed) writeOutput(data)
    })
    void window.phosphor.invoke('pty:attach', ptyId).then(({ scrollback }) => {
      if (termRef.current !== term) return // disposed mid-flight
      if (scrollback) writeOutput(scrollback)
      replayed = true
    })

    const unsubscribeExit = window.phosphor.onPtyExit(ptyId, (exitCode) => {
      term.write(`\r\n\x1b[2m[process exited with code ${exitCode}]\x1b[0m\r\n`)
      useTerminalStore.getState().markExited(ptyId)
    })

    // Resize plumbing (pane drags included).
    const sendResize = (): void => {
      void window.phosphor.invoke('pty:resize', ptyId, term.cols, term.rows)
    }
    const observer = new ResizeObserver(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        fit.fit()
        sendResize()
      }
    })
    observer.observe(container)
    sendResize()

    // Cmd/Ctrl+F opens in-pane search; ⌘C/⌘V (Ctrl+Shift+C/V) work the
    // clipboard via our explicit bindings (see clipboardKeys.ts).
    const platform = hostPlatform()
    term.attachCustomKeyEventHandler((event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'f' && event.type === 'keydown') {
        const previousFocus = document.activeElement
        setSearchOpen(true)
        setTimeout(() => {
          if (document.activeElement === previousFocus) searchInputRef.current?.focus()
        }, 30)
        return false
      }
      const action = clipboardActionFor(event, platform)
      // Returning false only skips xterm's key handling, not the browser's
      // default clipboard event. Cancel it so our paste is not sent twice.
      if (action) event.preventDefault()
      if (action === 'copy') {
        copySelection(term)
        return false
      }
      if (action === 'paste') {
        pasteFromClipboard(term)
        return false
      }
      return true
    })

    term.focus()

    return () => {
      observer.disconnect()
      dataDisposable.dispose()
      unsubscribeData()
      unsubscribeExit()
      links.dispose()
      term.dispose()
      termRef.current = null
    }
  }, [ptyId])

  // Live theme + font switching.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = xtermTheme(resolvedTheme)
  }, [resolvedTheme])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fonts.terminalFontSize
    term.options.fontFamily = `${fonts.monoFont}, ui-monospace, SF Mono, Menlo, monospace`
    fitRef.current?.fit()
  }, [fonts])

  // Refit + focus when this tab becomes visible.
  useEffect(() => {
    if (visible) {
      const previousFocus = document.activeElement
      const timer = setTimeout(() => {
        fitRef.current?.fit()
        // A late refit must not undo F6 or a user's click into another field.
        if (document.activeElement === previousFocus) termRef.current?.focus()
      }, 30)
      return () => clearTimeout(timer)
    }
  }, [visible])

  // "Run in terminal" paste queue.
  useEffect(() => {
    if (visible && ready && pendingPaste?.ptyId === ptyId && termRef.current) {
      const paste = useTerminalStore.getState().consumePaste(ptyId)
      if (paste) {
        const term = termRef.current
        // Old Readline (including macOS system Bash) executes pasted newlines.
        // Keep multiline input in an editor until the user explicitly runs it.
        if (!paste.execute && /[\r\n]/.test(paste.text) && !term.modes.bracketedPasteMode) {
          setStagedCommand(paste.text)
          return
        }
        setStagedCommand(null)
        term.paste(paste.text)
        // Enter is a keypress, not part of the bracketed paste payload.
        if (paste.execute) term.input('\r', true)
        term.focus()
      }
    }
  }, [pendingPaste, visible, ready, ptyId])

  /*
   * Right-click used to paste blind. It now opens the app's context menu, so
   * Copy is discoverable at all: xterm's selection is invisible to the browser,
   * which means no native menu ever offers to copy it.
   */
  const onContextMenu = (event: React.MouseEvent): void => {
    const term = termRef.current
    if (!term) return
    const mod = clipboardModifiers(hostPlatform())
    showContextMenu(event, [
      {
        label: 'Copy',
        shortcut: formatShortcut(...mod, 'C'),
        disabled: !term.hasSelection(),
        onClick: () => copySelection(term),
      },
      {
        label: 'Paste',
        shortcut: formatShortcut(...mod, 'V'),
        onClick: () => pasteFromClipboard(term),
      },
      {
        label: 'Select all',
        separatorAbove: true,
        onClick: () => {
          term.selectAll()
          term.focus()
        },
      },
    ])
  }

  const runSearch = (direction: 'next' | 'previous'): void => {
    if (!searchQuery) return
    if (direction === 'next') searchRef.current?.findNext(searchQuery)
    else searchRef.current?.findPrevious(searchQuery)
  }

  const runStagedCommand = (): void => {
    const term = termRef.current
    if (!term || stagedCommand === null) return
    term.paste(stagedCommand.replace(/[\r\n]+$/, ''))
    term.input('\r', true)
    setStagedCommand(null)
    term.focus()
  }

  return (
    <div className={visible ? 'relative h-full min-h-0 w-full' : 'hidden'}>
      {searchOpen && (
        <div className="border-border bg-surface-raised absolute right-2 top-2 z-10 flex items-center gap-1 rounded-lg border p-1 shadow-md">
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch(e.shiftKey ? 'previous' : 'next')
              if (e.key === 'Escape') {
                setSearchOpen(false)
                termRef.current?.focus()
              }
            }}
            placeholder="Search…"
            className="text-text placeholder:text-text-tertiary w-40 bg-transparent px-2 py-0.5 text-base outline-none"
          />
          <TooltipButton
            aria-label="Previous match"
            onClick={() => runSearch('previous')}
            className="text-text-tertiary hover:text-text px-1 text-sm"
          >
            ↑
          </TooltipButton>
          <TooltipButton
            aria-label="Next match"
            onClick={() => runSearch('next')}
            className="text-text-tertiary hover:text-text px-1 text-sm"
          >
            ↓
          </TooltipButton>
          <TooltipButton
            aria-label="Close search"
            onClick={() => {
              setSearchOpen(false)
              termRef.current?.focus()
            }}
            className="text-text-tertiary hover:text-text px-1 text-sm"
          >
            ✕
          </TooltipButton>
        </div>
      )}
      {stagedCommand !== null && (
        <div className="border-border bg-surface-raised absolute inset-x-2 bottom-2 z-10 rounded-lg border p-2 shadow-md">
          <p className="text-text-secondary mb-1 text-sm">
            This shell cannot safely paste multiple lines. Review, then Enter to run.
          </p>
          <textarea
            aria-label="Staged terminal command"
            autoFocus
            rows={3}
            value={stagedCommand}
            onChange={(event) => setStagedCommand(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                runStagedCommand()
              }
            }}
            className="border-border bg-code-bg text-text w-full rounded border p-2 font-mono text-sm outline-none"
          />
          <div className="mt-1 flex justify-end gap-2">
            <TooltipButton
              onClick={() => setStagedCommand(null)}
              className="text-text-secondary text-sm"
            >
              Cancel
            </TooltipButton>
            <TooltipButton onClick={runStagedCommand} className="text-accent text-sm">
              Run command
            </TooltipButton>
          </div>
        </div>
      )}
      <div
        ref={containerRef}
        onContextMenu={onContextMenu}
        className="terminal-container h-full w-full"
      />
    </div>
  )
})
