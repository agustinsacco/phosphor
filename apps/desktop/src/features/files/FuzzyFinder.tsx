import { REMOTE_UNAVAILABLE, useNavigationHostId } from '@/stores/remoteLanes'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useSessionsStore } from '@/stores/sessions'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ModalOverlay } from '@/components/Modal'
import { errorText } from '@shared/errors'
import { create } from 'zustand'
import { fuzzyFilter } from '@/lib/fuzzy'
import { openFileInWorkspace } from '@/stores/layout'
import { MenuRow } from '@/components/PopupMenu'
import { ignoreShortcut } from '@/lib/shortcutContext'
import { useWorkspaceSearchStore } from './workspaceSearchStore'
import { parseFileQuery } from './fileQuery'
import { runFileAction } from './fileActions'

interface FinderState {
  open: boolean
  setOpen: (open: boolean) => void
}

export const useFinderStore = create<FinderState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

/** Cmd/Ctrl+P fuzzy file finder — shares the @-mention file index. */
export function FuzzyFinder({
  workspacePath,
}: {
  workspacePath: string
}): React.JSX.Element | null {
  const open = useFinderStore((s) => s.open)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const hostId = useNavigationHostId()
  const hostHome = hostId !== undefined && activeSessionId === null
  useEffect(() => {
    if (open && hostHome) {
      useFinderStore.getState().setOpen(false)
      useExtensionUiStore.getState().pushToast(REMOTE_UNAVAILABLE)
    }
  }, [open, hostHome])
  // A new opening starts with fresh state before focus or typing can occur.
  return open && !hostHome ? (
    <FinderDialog key={workspacePath} workspacePath={workspacePath} />
  ) : null
}

function FinderDialog({ workspacePath }: { workspacePath: string }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState({
    workspacePath,
    files: [] as string[],
    loading: true,
    error: '',
  })
  const [activeIndex, setActiveIndex] = useState(0)
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    const previousFocus = document.activeElement
    inputRef.current?.focus()
    void window.phosphor.invoke('fs:listFiles', workspacePath).then(
      (files) => {
        if (!cancelled) setIndex({ workspacePath, files, loading: false, error: '' })
      },
      (error) => {
        if (!cancelled)
          setIndex({ workspacePath, files: [], loading: false, error: errorText(error) })
      },
    )
    return () => {
      cancelled = true
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [workspacePath])

  const parsed = parseFileQuery(query)
  const matches = useMemo(
    () =>
      index.workspacePath === workspacePath
        ? fuzzyFilter(parsed.path, index.files, (f) => f, 14)
        : [],
    [parsed.path, index, workspacePath],
  )

  const close = (): void => useFinderStore.getState().setOpen(false)

  const pick = (file: string): void => {
    close()
    useWorkspaceSearchStore.getState().closeSearch(workspacePath)
    const { activeSessionId, live } = useSessionsStore.getState()
    const sessionId =
      activeSessionId && live[activeSessionId]?.workspacePath === workspacePath
        ? activeSessionId
        : undefined
    runFileAction(openFileInWorkspace(workspacePath, file, parsed.target, sessionId))
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (ignoreShortcut(event.nativeEvent)) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((i) => (i + 1) % Math.max(1, matches.length))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((i) => (i - 1 + matches.length) % Math.max(1, matches.length))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const file = matches[activeIndex]
      if (file) pick(file)
    }
  }

  return (
    <ModalOverlay onClose={close} align="top" className="pt-[18vh]">
      <div
        data-shortcut-overlay="finder"
        role="dialog"
        aria-modal="true"
        aria-label="Go to file"
        onKeyDown={(event) => {
          if (event.key === 'Tab') {
            event.preventDefault()
            inputRef.current?.focus()
          }
        }}
        className="border-border bg-surface-raised w-[560px] max-w-[92vw] overflow-hidden rounded-xl border shadow-2xl"
      >
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Go to file"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={matches[activeIndex] ? `${listId}-${activeIndex}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActiveIndex(0)
          }}
          onKeyDown={onKeyDown}
          placeholder="Go to file…"
          className="text-text placeholder:text-text-tertiary border-border block w-full border-b bg-transparent px-4 py-3 text-lg outline-none"
          data-tooltip="Go to file"
        />
        <div
          id={listId}
          role="listbox"
          aria-label="Matching files"
          className="max-h-80 overflow-y-auto py-1"
        >
          {matches.map((file, index) => {
            const slash = file.lastIndexOf('/')
            const dir = slash === -1 ? '' : file.slice(0, slash + 1)
            const base = slash === -1 ? file : file.slice(slash + 1)
            return (
              <MenuRow
                key={file}
                id={`${listId}-${index}`}
                role="option"
                ariaSelected={index === activeIndex}
                active={index === activeIndex}
                onHover={() => setActiveIndex(index)}
                onClick={() => pick(file)}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-base">
                  <span className="text-text font-medium">{base}</span>
                  {dir && <span className="text-text-tertiary ml-2">{dir}</span>}
                </span>
              </MenuRow>
            )
          })}
        </div>
        {(index.loading || index.error || matches.length === 0) && (
          <div role="status" className="text-text-tertiary px-4 py-4 text-center text-base">
            {index.loading
              ? 'Loading files…'
              : index.error
                ? `Could not list files: ${index.error}`
                : 'No matching files'}
          </div>
        )}
        <div className="border-border text-text-tertiary border-t px-4 py-2 text-xs">
          Add :line or :line:column to jump to a location.
        </div>
      </div>
    </ModalOverlay>
  )
}
