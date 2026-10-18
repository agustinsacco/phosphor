import type { ToolState } from '@/features/chat/reducer'
import { editDiffStats, toolDetails, type EditDetails } from '@/features/chat/tools/toolSummaries'

export interface TouchedFile {
  relativePath: string
  created: boolean
  additions: number
  deletions: number
  /** Unified patches in session order (edit tools only). */
  patches: string[]
}

/**
 * Make a workspace-absolute path relative to the workspace root.
 * Paths outside the workspace, and already-relative paths, are returned as-is.
 */
function toWorkspaceRelative(rawPath: string, workspacePath: string): string {
  if (!rawPath.startsWith('/')) return rawPath
  return rawPath.startsWith(workspacePath + '/') ? rawPath.slice(workspacePath.length + 1) : rawPath
}

/**
 * Aggregate completed edit/write tool results for a session into per-file rows,
 * accumulating line counts and unified patches across repeated edits of one file.
 */
export function collectTouchedFiles(
  tools: Record<string, ToolState | undefined>,
  workspacePath: string,
): TouchedFile[] {
  const byPath = new Map<string, TouchedFile>()
  for (const tool of Object.values(tools)) {
    if (!tool || tool.status !== 'done') continue
    if (tool.toolName !== 'edit' && tool.toolName !== 'write') continue
    const rawPath = typeof tool.args?.path === 'string' ? tool.args.path : null
    if (!rawPath) continue
    const rel = toWorkspaceRelative(rawPath, workspacePath)

    const entry = byPath.get(rel) ?? {
      relativePath: rel,
      created: false,
      additions: 0,
      deletions: 0,
      patches: [],
    }
    if (tool.toolName === 'write') {
      entry.created = true
      const content = typeof tool.args?.content === 'string' ? tool.args.content : ''
      entry.additions += content ? content.split('\n').length : 0
    } else {
      const stats = editDiffStats(tool)
      if (stats) {
        entry.additions += stats.additions
        entry.deletions += stats.deletions
      }
      const details = toolDetails<EditDetails>(tool)
      if (details?.patch) entry.patches.push(details.patch)
    }
    byPath.set(rel, entry)
  }
  return [...byPath.values()]
}
