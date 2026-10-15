import { useMemo, useState } from 'react'
import { REMOTE_UNAVAILABLE } from '@/stores/remoteLanes'
import { ChevronIcon } from '@/components/icons'
import { FolderGlyph } from './FileExplorer'
import { FileTreeRow } from './FileTreeRow'

/** A Host list is relative paths, not a local directory handle. */
export function RemoteFileTree({
  files,
  selected,
  onSelect,
  status = {},
  disabled = false,
  loading = false,
  changes = false,
}: {
  files: string[]
  selected: string | null
  onSelect(path: string): void
  status?: Record<string, string>
  disabled?: boolean
  loading?: boolean
  changes?: boolean
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const nodes = useMemo(() => {
    const entries = new Map<
      string,
      { path: string; name: string; directory: boolean; depth: number }
    >()
    for (const file of files) {
      const parts = file.split('/')
      if (parts.length > 64) return null
      for (let i = 0; i < parts.length; i++) {
        const path = parts.slice(0, i + 1).join('/')
        if (entries.size >= 50000) return null
        entries.set(path, {
          path,
          name: parts[i] ?? '',
          directory: i < parts.length - 1,
          depth: i,
        })
      }
    }
    return [...entries.values()].sort((a, b) => {
      const ap = a.path.split('/'),
        bp = b.path.split('/')
      for (let i = 0; i < Math.min(ap.length, bp.length); i++) {
        if (ap[i] === bp[i]) continue
        const ad = i < ap.length - 1 || a.directory,
          bd = i < bp.length - 1 || b.directory
        if (ad !== bd) return ad ? -1 : 1
        return (ap[i] ?? '').localeCompare(bp[i] ?? '')
      }
      return ap.length - bp.length
    })
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
        .filter(
          (n) =>
            !n.path
              .split('/')
              .slice(0, -1)
              .some((_p, i, parts) => collapsed.has(parts.slice(0, i + 1).join('/'))),
        )
        .map((n) => (
          <FileTreeRow
            key={n.path}
            role="treeitem"
            aria-level={n.depth + 1}
            aria-expanded={n.directory ? !collapsed.has(n.path) : undefined}
            active={selected === n.path}
            depth={n.depth}
            disabled={disabled}
            onClick={() => {
              if (n.directory)
                setCollapsed((old) => {
                  const next = new Set(old)
                  if (next.has(n.path)) next.delete(n.path)
                  else next.add(n.path)
                  return next
                })
              else onSelect(n.path)
            }}
          >
            {n.directory ? (
              <>
                <ChevronIcon
                  size={9}
                  strokeWidth={3}
                  expanded={!collapsed.has(n.path)}
                  className="text-text-tertiary"
                />
                <FolderGlyph open={!collapsed.has(n.path)} />
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
