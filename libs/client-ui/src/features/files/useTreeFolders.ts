import { useCallback, useState } from 'react'

export interface TreeFolders {
  isOpen(path: string): boolean
  toggle(path: string): void
  collapseAll(): void
}

interface FolderState {
  /** Whether a folder nobody has toggled is open. */
  open: boolean
  /** Folders toggled away from `open`. */
  toggled: ReadonlySet<string>
}

const ancestors = (path: string): string[] =>
  path
    .split('/')
    .slice(0, -1)
    .map((_p, i, parts) => parts.slice(0, i + 1).join('/'))

/**
 * Which folders of a Host file tree are open. Files start collapsed; the changes
 * view starts expanded, since its short list is the point of opening it. The
 * selected file's folders open whenever the selection changes, so a file picked
 * from search or a chat link is visible.
 */
export function useTreeFolders(selected: string | null, openByDefault = false): TreeFolders {
  const [state, setState] = useState<FolderState>({ open: openByDefault, toggled: new Set() })
  const [seen, setSeen] = useState({ selected, openByDefault })
  if (seen.selected !== selected || seen.openByDefault !== openByDefault) {
    setSeen({ selected, openByDefault })
    const base: FolderState =
      seen.openByDefault === openByDefault ? state : { open: openByDefault, toggled: new Set() }
    const closed = selected
      ? ancestors(selected).filter((p) => base.open === base.toggled.has(p))
      : []
    if (base !== state || closed.length)
      setState(closed.length ? { open: base.open, toggled: toggleAll(base.toggled, closed) } : base)
  }
  const isOpen = useCallback((path: string) => state.open !== state.toggled.has(path), [state])
  const toggle = useCallback(
    (path: string) => setState((s) => ({ open: s.open, toggled: toggleAll(s.toggled, [path]) })),
    [],
  )
  const collapseAll = useCallback(() => setState({ open: false, toggled: new Set() }), [])
  return { isOpen, toggle, collapseAll }
}

function toggleAll(set: ReadonlySet<string>, paths: string[]): Set<string> {
  const next = new Set(set)
  for (const p of paths) {
    if (next.has(p)) next.delete(p)
    else next.add(p)
  }
  return next
}
