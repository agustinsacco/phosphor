import { useMemo } from 'react'
import { REMOTE_UNAVAILABLE } from '@/stores/hostRefusals'
import { ChevronIcon } from '@/components/icons'
import { FileTreeRow, FolderGlyph } from './FileTreeRow'
import { foldFileList } from './fileListTree'
import { useTreeFolders, type TreeFolders } from './useTreeFolders'

/** A Host list is relative paths, not a local directory handle. */
export function RemoteFileTree({
  files,
  selected,
  onSelect,
  status = {},
  loading = false,
  changes = false,
  folders,
}: {
  files: string[]
  selected: string | null
  onSelect(path: string): void
  status?: Record<string, string>
  loading?: boolean
  changes?: boolean
  /** Folder state a pane owns, for a toolbar's collapse-all; the tree's own otherwise. */
  folders?: TreeFolders
}): React.JSX.Element {
  const own = useTreeFolders(selected, changes)
  const { isOpen, toggle } = folders ?? own
  const nodes = useMemo(() => {
    const listings = foldFileList('', files)
    if (!listings) return null
    const nodes: { path: string; name: string; directory: boolean; depth: number }[] = []
    const walk = (dir: string, depth: number): void => {
      for (const entry of listings[dir] ?? []) {
        nodes.push({ path: entry.path, name: entry.name, directory: entry.isDirectory, depth })
        if (entry.isDirectory) walk(entry.path, depth + 1)
      }
    }
    walk('', 0)
    return nodes
  }, [files])
  if (loading)
    return (
      <p role="status" className="text-text-tertiary animate-pulse px-3 py-2">
        Loading…
      </p>
    )
  if (!nodes)
    return (
      <p role="alert" className="text-text-tertiary px-3 py-2">
        {REMOTE_UNAVAILABLE}
      </p>
    )
  if (!files.length)
    return (
      <p className="text-text-tertiary px-3 py-2">{changes ? 'No changes yet' : 'No files yet'}</p>
    )
  return (
    <div role="tree" aria-label={changes ? 'Changed files' : 'Files'} className="py-1">
      {nodes
        .filter((n) =>
          n.path
            .split('/')
            .slice(0, -1)
            .every((_p, i, parts) => isOpen(parts.slice(0, i + 1).join('/'))),
        )
        .map((n) => (
          <FileTreeRow
            key={n.path}
            role="treeitem"
            aria-level={n.depth + 1}
            aria-expanded={n.directory ? isOpen(n.path) : undefined}
            active={selected === n.path}
            depth={n.depth}
            onClick={() => {
              if (n.directory) toggle(n.path)
              else onSelect(n.path)
            }}
          >
            {n.directory ? (
              <>
                <ChevronIcon
                  size={9}
                  strokeWidth={3}
                  expanded={isOpen(n.path)}
                  className="text-text-tertiary"
                />
                <FolderGlyph open={isOpen(n.path)} />
              </>
            ) : (
              <span className="w-[13px]" />
            )}
            <span className="min-w-0 flex-1 truncate">{n.name}</span>
            {!n.directory && status[n.path] && (
              <span className="text-text-tertiary text-xs font-mono">{status[n.path]}</span>
            )}
          </FileTreeRow>
        ))}
    </div>
  )
}
