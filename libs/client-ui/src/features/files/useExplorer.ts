import { useEffect, useRef, useState } from 'react'
import type { DirEntry } from '@shared/models'
import type { ContextMenuItem } from '@/components/ContextMenu'
import { useFilesStore, workspaceFiles } from '@/stores/files'
import { dirname } from '@/lib/path'
import { formatShortcut } from '@/lib/shortcuts'
import { ignoreShortcut } from '@/lib/shortcutContext'
import { renameEntry, runFileAction, trashEntry } from './fileActions'
import { entryDirectory, FILE_DRAG, importFiles, pasteFiles, transferFiles } from './fileTransfers'
import type { FilesSource } from './filesSource'

export function useExplorer(source: FilesSource) {
  const { workspacePath: workspace, features, writeRefusal } = source
  const activePath = useFilesStore((s) => workspaceFiles(s, workspace).activePath)
  const activeRequest = useFilesStore((s) => workspaceFiles(s, workspace).activeRequest)
  const [selectionState, setSelectionState] = useState({
    workspace,
    activePath: null as string | null,
    activeRequest: undefined as number | undefined,
    entries: [] as DirEntry[],
  })
  const setSelected = (entries: DirEntry[]): void =>
    setSelectionState({ workspace, activePath, activeRequest, entries })
  const rangeAnchor = useRef<string | null>(null)
  const typeahead = useRef({ text: '', time: 0, workspace })
  const listings = useFilesStore((s) => s.entries)
  const activeEntry = activePath
    ? listings[dirname(activePath)]?.find((entry) => entry.path === activePath)
    : undefined
  const selected = (
    selectionState.workspace === workspace &&
    selectionState.activePath === activePath &&
    selectionState.activeRequest === activeRequest
      ? selectionState.entries
      : activeEntry
        ? [activeEntry]
        : []
  ).filter((entry) => listings[dirname(entry.path)]?.some((e) => e.path === entry.path))

  useEffect(() => {
    if (!activePath) return
    let cancelled = false
    // Walk only the active file's ancestors through the filtered listings.
    // Never scan unrelated subtrees or undo a user's hidden/gitignore filters.
    const reveal = async (): Promise<void> => {
      let dir = workspace
      while (!cancelled) {
        if (!useFilesStore.getState().entries[dir])
          await useFilesStore.getState().refreshDir(workspace, dir)
        if (cancelled) return
        const ancestor = useFilesStore
          .getState()
          .entries[dir]?.find(
            (entry) =>
              entry.isDirectory &&
              (activePath.startsWith(entry.path + '/') || activePath.startsWith(entry.path + '\\')),
          )
        if (!ancestor) return
        dir = ancestor.path
        useFilesStore.setState((s) => ({ expanded: { ...s.expanded, [dir]: true } }))
      }
    }
    void reveal()
    return () => {
      cancelled = true
    }
  }, [workspace, activePath, activeRequest])
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
    window.phosphor.invoke(
      'clipboard:writeFiles',
      selection(entry).map((e) => e.path),
      cut,
    )
  // A drag within the explorer moves or copies through fs:transfer; files from the OS need a local lane.
  const accepts = (type: string): boolean =>
    !writeRefusal && (type === FILE_DRAG || (type === 'Files' && features.clipboardFiles))
  const directory = (target: EventTarget): string => {
    const row = (target as HTMLElement).closest<HTMLElement>('[data-path]')
    return row
      ? row.dataset.directory === 'true'
        ? row.dataset.path!
        : dirname(row.dataset.path!)
      : workspace
  }
  // The OS clipboard and picker hold this device's paths, so only a local lane offers them.
  const menu = (entry?: DirEntry): ContextMenuItem[] =>
    features.clipboardFiles ? clipboardMenu(entry) : []
  const clipboardMenu = (entry?: DirEntry): ContextMenuItem[] => [
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
    activePath,
    selected,
    dropDir,
    busy,
    menu,
    select: (entry: DirEntry, event: React.MouseEvent): boolean => {
      const anchor = selected.find((e) => e.path === rangeAnchor.current) ?? selected[0]
      if (!event.shiftKey) rangeAnchor.current = entry.path
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
        if (features.clipboardFiles && selected.length) {
          event.preventDefault()
          run(() => copy(false))
        }
      },
      onCut: (event: React.ClipboardEvent): void => {
        if (features.clipboardFiles && selected.length) {
          event.preventDefault()
          run(() => copy(true))
        }
      },
      onPaste: (event: React.ClipboardEvent): void => {
        if (!features.clipboardFiles) return
        event.preventDefault()
        run(() => pasteFiles(workspace, entryDirectory(workspace, selected.at(-1))))
      },
      onDragOver: (event: React.DragEvent): void => {
        if (!event.dataTransfer.types.some(accepts)) return
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
        if (!event.dataTransfer.types.some(accepts)) return
        event.preventDefault()
        event.stopPropagation()
        setDropDir(null)
        const raw = event.dataTransfer.getData(FILE_DRAG)
        const files = [...event.dataTransfer.files].map((file) => window.phosphor.pathForFile(file))
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
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>): void =>
        explorerKeyDown(event, {
          workspace,
          selected,
          setSelected,
          rangeAnchor,
          typeahead,
          entriesFor,
          run,
          copy: features.clipboardFiles ? copy : undefined,
          writable: !writeRefusal,
        }),
    },
  }
}

interface ExplorerKeys {
  workspace: string
  selected: DirEntry[]
  setSelected: (entries: DirEntry[]) => void
  rangeAnchor: React.RefObject<string | null>
  typeahead: React.RefObject<{ text: string; time: number; workspace: string }>
  entriesFor: (root: HTMLElement) => DirEntry[]
  run: (action: () => Promise<unknown>) => void
  /** Copy to the file clipboard; absent where the lane has none, which also rules out paste. */
  copy?: (cut: boolean) => Promise<void>
  writable: boolean
}

/** The explorer's keys: clipboard, rename, trash, arrows, ranges and type-to-find. */
function explorerKeyDown(event: React.KeyboardEvent<HTMLElement>, keys: ExplorerKeys): void {
  const { workspace, selected, setSelected, entriesFor, run, copy, writable } = keys
  if (ignoreShortcut(event.nativeEvent)) return
  const entry = selected.at(-1)
  const mod = event.metaKey || event.ctrlKey
  let action: (() => Promise<unknown>) | undefined
  const key = event.key.toLowerCase()
  if (copy && mod && (key === 'c' || key === 'x') && selected.length)
    action = () => copy(key === 'x')
  if (copy && writable && mod && key === 'v')
    action = () => pasteFiles(workspace, entryDirectory(workspace, entry))
  if (writable && selected.length === 1 && event.key === 'F2')
    action = () => renameEntry(workspace, entry!)
  if (
    writable &&
    selected.length === 1 &&
    (event.key === 'Delete' || (mod && event.key === 'Backspace'))
  )
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
  moveExplorerFocus(event, keys, entries)
}

/** Arrows, Home/End, shift ranges, folder open/close and type-to-find over the visible rows. */
function moveExplorerFocus(
  event: React.KeyboardEvent<HTMLElement>,
  { workspace, selected, setSelected, rangeAnchor, typeahead, run }: ExplorerKeys,
  entries: DirEntry[],
): void {
  const mod = event.metaKey || event.ctrlKey
  const index = entries.findIndex(
    (e) =>
      e.path === (event.target as HTMLElement).closest<HTMLElement>('[data-path]')?.dataset.path,
  )
  const focused = entries[index]
  const focusEntry = (next: DirEntry): void => {
    event.preventDefault()
    event.stopPropagation()
    if (event.shiftKey && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      const anchor = entries.findIndex(
        (e) => e.path === rangeAnchor.current && selected.some((s) => s.path === e.path),
      )
      const from = anchor >= 0 ? anchor : Math.max(index, 0)
      rangeAnchor.current = entries[from]?.path ?? next.path
      const to = entries.indexOf(next)
      setSelected(entries.slice(Math.min(from, to), Math.max(from, to) + 1))
    } else {
      rangeAnchor.current = next.path
      setSelected([next])
    }
    const rows = event.currentTarget.querySelectorAll<HTMLElement>('[data-path]')
    rows[entries.indexOf(next)]?.focus()
  }
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
  if (next) focusEntry(next)
  if (focused && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault()
    const store = useFilesStore.getState()
    const expanded = focused.isDirectory && store.expanded[focused.path]
    if (
      (event.key === 'ArrowLeft' && expanded) ||
      (event.key === 'ArrowRight' && focused.isDirectory && !expanded)
    ) {
      run(() => store.toggleDir(workspace, focused.path))
    } else {
      const target =
        event.key === 'ArrowLeft'
          ? entries.find((e) => e.path === dirname(focused.path))
          : expanded
            ? entries[index + 1]
            : undefined
      if (target && (event.key === 'ArrowLeft' || dirname(target.path) === focused.path))
        focusEntry(target)
    }
  }
  if (!mod && !event.altKey && event.key.length === 1 && event.key !== ' ') {
    const previous = typeahead.current
    const key = event.key.toLocaleLowerCase()
    const continued = previous.workspace === workspace && Date.now() - previous.time < 800
    const text = continued && previous.text !== key ? previous.text + key : key
    typeahead.current = { text, time: Date.now(), workspace }
    const start = text.length > 1 ? Math.max(index, 0) : index + 1
    const ordered = [...entries.slice(start), ...entries.slice(0, start)]
    const match = ordered.find((e) => e.name.toLocaleLowerCase().startsWith(text))
    if (match) focusEntry(match)
  }
}
