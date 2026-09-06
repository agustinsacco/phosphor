import { useRef, useState } from 'react'
import type { DirEntry } from '@shared/models'
import type { ContextMenuItem } from '@/components/ContextMenu'
import { useFilesStore } from '@/stores/files'
import { dirname } from '@/lib/path'
import { formatShortcut } from '@/lib/shortcuts'
import { renameEntry, runFileAction, trashEntry } from './fileActions'
import { entryDirectory, FILE_DRAG, importFiles, pasteFiles, transferFiles } from './fileTransfers'

export function useExplorer(workspace: string) {
  const [selectionState, setSelectionState] = useState({ workspace, entries: [] as DirEntry[] })
  const setSelected = (entries: DirEntry[]): void => setSelectionState({ workspace, entries })
  const listings = useFilesStore((s) => s.entries)
  const selected = (selectionState.workspace === workspace ? selectionState.entries : []).filter(
    (entry) => listings[dirname(entry.path)]?.some((e) => e.path === entry.path),
  )
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const run = (action: () => Promise<unknown>): void => {
    if (running.current) return
    running.current = true
    setBusy(true)
    runFileAction(
      action().finally(() => {
        running.current = false
        setBusy(false)
      }),
    )
  }
  const entriesFor = (root: HTMLElement): DirEntry[] => {
    const entries = Object.values(useFilesStore.getState().entries).flatMap((v) => v ?? [])
    const byPath = new Map(entries.map((entry) => [entry.path, entry]))
    return [...root.querySelectorAll<HTMLElement>('[data-path]')].flatMap((row) => {
      const entry = byPath.get(row.dataset.path!)
      return entry ? [entry] : []
    })
  }
  const selection = (entry?: DirEntry): DirEntry[] =>
    entry && !selected.some((e) => e.path === entry.path) ? [entry] : selected
  const copy = (cut: boolean, entry?: DirEntry): Promise<void> =>
    window.pidex.invoke(
      'clipboard:writeFiles',
      selection(entry).map((e) => e.path),
      cut,
    )
  const directory = (target: EventTarget): string => {
    const row = (target as HTMLElement).closest<HTMLElement>('[data-path]')
    return row
      ? row.dataset.directory === 'true'
        ? row.dataset.path!
        : dirname(row.dataset.path!)
      : workspace
  }
  const menu = (entry?: DirEntry): ContextMenuItem[] => [
    {
      label: 'Copy',
      shortcut: formatShortcut('mod', 'C'),
      disabled: busy || !selection(entry).length,
      separatorAbove: true,
      onClick: () => run(() => copy(false, entry)),
    },
    {
      label: 'Cut',
      shortcut: formatShortcut('mod', 'X'),
      disabled: busy || !selection(entry).length,
      onClick: () => run(() => copy(true, entry)),
    },
    {
      label: 'Paste',
      shortcut: formatShortcut('mod', 'V'),
      disabled: busy,
      onClick: () => run(() => pasteFiles(workspace, entryDirectory(workspace, entry))),
    },
    ...(['file', 'folder'] as const).map((kind) => ({
      label: `Import ${kind}s…`,
      disabled: busy,
      onClick: () => run(() => importFiles(workspace, entryDirectory(workspace, entry), kind)),
    })),
  ]
  return {
    selected,
    dropDir,
    busy,
    menu,
    select: (entry: DirEntry, event: React.MouseEvent): boolean => {
      const anchor = selected[0]
      if (event.shiftKey && anchor) {
        const entries = entriesFor(
          event.currentTarget.closest<HTMLElement>('[data-testid="file-explorer"]')!,
        )
        const a = entries.findIndex((e) => e.path === anchor.path),
          b = entries.findIndex((e) => e.path === entry.path)
        setSelected(entries.slice(Math.min(a, b), Math.max(a, b) + 1))
      } else if (event.metaKey || event.ctrlKey) {
        setSelected(
          selected.some((e) => e.path === entry.path)
            ? selected.filter((e) => e.path !== entry.path)
            : [...selected, entry],
        )
      } else setSelected([entry])
      return !event.shiftKey && !event.metaKey && !event.ctrlKey
    },
    context: (entry?: DirEntry): void => setSelected(entry ? selection(entry) : []),
    dragStart: (event: React.DragEvent, entry: DirEntry): void => {
      event.dataTransfer.setData(FILE_DRAG, JSON.stringify(selection(entry).map((e) => e.path)))
      event.dataTransfer.effectAllowed = 'copyMove'
    },
    rootProps: {
      tabIndex: 0,
      'aria-label': 'File explorer',
      'aria-busy': busy,
      onClick: (event: React.MouseEvent<HTMLElement>): void => {
        if (!(event.target as HTMLElement).closest('button')) {
          setSelected([])
          event.currentTarget.focus()
        }
      },
      onCopy: (event: React.ClipboardEvent): void => {
        if (selected.length) {
          event.preventDefault()
          run(() => copy(false))
        }
      },
      onCut: (event: React.ClipboardEvent): void => {
        if (selected.length) {
          event.preventDefault()
          run(() => copy(true))
        }
      },
      onPaste: (event: React.ClipboardEvent): void => {
        event.preventDefault()
        run(() => pasteFiles(workspace, entryDirectory(workspace, selected.at(-1))))
      },
      onDragOver: (event: React.DragEvent): void => {
        if (!event.dataTransfer.types.some((t) => t === 'Files' || t === FILE_DRAG)) return
        event.preventDefault()
        event.stopPropagation()
        setDropDir(directory(event.target))
        event.dataTransfer.dropEffect = busy
          ? 'none'
          : event.dataTransfer.types.includes(FILE_DRAG) && !event.altKey && !event.ctrlKey
            ? 'move'
            : 'copy'
      },
      onDragLeave: (event: React.DragEvent): void => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropDir(null)
      },
      onDragEnd: (): void => setDropDir(null),
      onDrop: (event: React.DragEvent): void => {
        event.preventDefault()
        event.stopPropagation()
        setDropDir(null)
        const raw = event.dataTransfer.getData(FILE_DRAG)
        const files = [...event.dataTransfer.files].map((file) => window.pidex.pathForFile(file))
        const dir = directory(event.target)
        run(async () => {
          const paths: unknown = raw ? JSON.parse(raw) : files
          if (
            !Array.isArray(paths) ||
            !paths.length ||
            !paths.every((p) => typeof p === 'string' && p)
          )
            throw new Error('Drop files or folders from your file manager.')
          await transferFiles(workspace, paths, dir, !!raw && !event.altKey && !event.ctrlKey)
        })
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>): void => {
        const entry = selected.at(-1)
        const mod = event.metaKey || event.ctrlKey
        let action: (() => Promise<unknown>) | undefined
        if (mod && event.key.toLowerCase() === 'c' && selected.length) action = () => copy(false)
        if (mod && event.key.toLowerCase() === 'x' && selected.length) action = () => copy(true)
        if (mod && event.key.toLowerCase() === 'v')
          action = () => pasteFiles(workspace, entryDirectory(workspace, entry))
        if (selected.length === 1 && event.key === 'F2')
          action = () => renameEntry(workspace, entry!)
        if (selected.length === 1 && (event.key === 'Delete' || (mod && event.key === 'Backspace')))
          action = () => trashEntry(workspace, entry!)
        if (action) {
          event.preventDefault()
          event.stopPropagation()
          run(action)
          return
        }
        const entries = entriesFor(event.currentTarget)
        if (mod && event.key.toLowerCase() === 'a') {
          event.preventDefault()
          event.stopPropagation()
          setSelected(entries)
          return
        }
        const index = entries.findIndex(
          (e) =>
            e.path ===
            (event.target as HTMLElement).closest<HTMLElement>('[data-path]')?.dataset.path,
        )
        const next =
          event.key === 'Home'
            ? entries[0]
            : event.key === 'End'
              ? entries.at(-1)
              : event.key === 'ArrowDown'
                ? entries[Math.min(index + 1, entries.length - 1)]
                : event.key === 'ArrowUp'
                  ? entries[Math.max(index - 1, 0)]
                  : undefined
        if (next) {
          event.preventDefault()
          setSelected([next])
          const rows = event.currentTarget.querySelectorAll<HTMLElement>('[data-path]')
          rows[entries.indexOf(next)]?.focus()
        }
        if (entry?.isDirectory && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault()
          const store = useFilesStore.getState()
          if (!!store.expanded[entry.path] !== (event.key === 'ArrowRight'))
            run(() => store.toggleDir(workspace, entry.path))
        }
      },
    },
  }
}
