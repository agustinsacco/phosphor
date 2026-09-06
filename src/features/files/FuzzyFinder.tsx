import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { fuzzyFilter } from '@/lib/fuzzy'
import { openFileInWorkspace } from '@/stores/layout'
import { MenuRow } from '@/components/PopupMenu'
import { ignoreShortcut } from '@/lib/shortcutContext'

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
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    void window.pidex.invoke('fs:listFiles', workspacePath).then(setFiles)
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [open, workspacePath])

  const matches = useMemo(() => fuzzyFilter(query, files, (f) => f, 14), [query, files])

  if (!open) return null
  const close = (): void => useFinderStore.getState().setOpen(false)

  const pick = (file: string): void => {
    close()
    void openFileInWorkspace(workspacePath, file)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (ignoreShortcut(event.nativeEvent)) return
    if (event.key === 'Escape') close()
    else if (event.key === 'ArrowDown') {
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

  return createPortal(
    <div
      data-shortcut-overlay="finder"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[18vh] backdrop-blur-[2px]"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="border-border bg-surface-raised w-[560px] overflow-hidden rounded-xl border shadow-2xl"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActiveIndex(0)
          }}
          onKeyDown={onKeyDown}
          placeholder="Go to file…"
          className="text-text placeholder:text-text-tertiary border-border block w-full border-b bg-transparent px-4 py-3 text-lg outline-none"
        />
        <div className="max-h-80 overflow-y-auto py-1">
          {matches.map((file, index) => {
            const slash = file.lastIndexOf('/')
            const dir = slash === -1 ? '' : file.slice(0, slash + 1)
            const base = slash === -1 ? file : file.slice(slash + 1)
            return (
              <MenuRow
                key={file}
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
          {matches.length === 0 && (
            <div className="text-text-tertiary px-4 py-4 text-center text-base">
              No matching files
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
