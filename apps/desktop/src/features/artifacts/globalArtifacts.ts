import { basename } from '@/lib/path'
import type { HostsSnapshot } from '@shared/ipc'
import type { ArtifactListing } from '@shared/artifacts'
import { normalizeArtifactType, type Artifact } from '@/stores/artifacts'

/**
 * The global Artifacts page's rows: the artifact store's listing, merged with
 * what open sessions hold live, then folded across forks. Pure, so all of it
 * is testable without React.
 */
export interface GlobalArtifactRow {
  machine?: string
  key: string
  id: string
  title: string
  type: Artifact['type']
  version: number
  updatedAt: number
  cwd: string
  sessionFile?: string
  sessionName?: string
  firstUserText?: string
  sessionDeleted: boolean
  /** False when the session's folder is gone: it can only be viewed here. */
  workspaceExists: boolean
  /** Forks holding this same version, folded into this row. */
  copies: number
  /** The session is open in this window. */
  phosphorId?: string
}

export interface LiveSessionArtifacts {
  machine?: string
  phosphorId: string
  diskPath?: string
  workspacePath: string
  artifacts: Record<string, Artifact>
}

/**
 * The store's rows, with what open sessions hold live laid over them: a turn
 * still running has not reached the session file, so the store cannot have
 * its newest versions yet, and a brand-new session has no file at all.
 */
export function mergeGlobalArtifacts(
  stored: ArtifactListing[],
  live: LiveSessionArtifacts[],
): GlobalArtifactRow[] {
  const rows = new Map<string, { row: GlobalArtifactRow; revision: string }>()
  const openFiles = new Map<string, string>()
  for (const session of live) {
    if (session.diskPath) openFiles.set(session.diskPath, session.phosphorId)
  }
  for (const listing of stored) {
    rows.set(`${listing.sessionFile}\u0000${listing.id}`, {
      revision: listing.revision,
      row: {
        key: listing.key,
        machine: listing.machine,
        id: listing.id,
        title: listing.title,
        type: normalizeArtifactType(listing.type),
        version: listing.version,
        updatedAt: listing.updatedAt,
        cwd: listing.cwd,
        sessionFile: listing.sessionFile,
        sessionName: listing.sessionName,
        firstUserText: listing.firstUserText,
        sessionDeleted: listing.sessionDeleted,
        workspaceExists: listing.workspaceExists,
        copies: 0,
        phosphorId: openFiles.get(listing.sessionFile),
      },
    })
  }
  for (const session of live) {
    for (const artifact of Object.values(session.artifacts)) {
      const latest = artifact.versions[artifact.versions.length - 1]
      if (!latest) continue
      const at = `${session.diskPath ?? `live:${session.phosphorId}`}\u0000${artifact.id}`
      const row = rows.get(at)?.row
      if (row && row.version >= latest.version) continue
      const key = row?.key ?? `live:${session.phosphorId}/${artifact.id}`
      rows.set(at, {
        // A version the file does not have yet is no fork's copy.
        revision: `live:${key}`,
        row: {
          key,
          machine: row?.machine ?? session.machine,
          id: artifact.id,
          title: artifact.title,
          type: artifact.type,
          version: latest.version,
          updatedAt: Math.max(row?.updatedAt ?? 0, artifact.updatedAt),
          cwd: row?.cwd ?? session.workspacePath,
          sessionFile: session.diskPath,
          sessionName: row?.sessionName,
          firstUserText: row?.firstUserText,
          sessionDeleted: false,
          workspaceExists: true,
          copies: 0,
          phosphorId: session.phosphorId,
        },
      })
    }
  }
  return foldForks([...rows.values()]).sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * A fork copies its parent's entries, tool call ids included, so an artifact
 * neither side has touched since appears once per fork. Rows whose current
 * version is the same record fold into one: an open session first, then one
 * that still exists, then the newest (session file names start with their
 * creation time). A fork that changed the artifact keeps its own row.
 */
function foldForks(rows: Array<{ row: GlobalArtifactRow; revision: string }>): GlobalArtifactRow[] {
  const groups = new Map<string, GlobalArtifactRow[]>()
  for (const { row, revision } of rows) {
    const group = `${row.id}\u0000${revision}`
    groups.set(group, [...(groups.get(group) ?? []), row])
  }
  return [...groups.values()].map((group) => {
    const [first, ...rest] = group.sort(
      (a, b) =>
        Number(!a.phosphorId) - Number(!b.phosphorId) ||
        Number(a.sessionDeleted) - Number(b.sessionDeleted) ||
        basename(b.sessionFile ?? '').localeCompare(basename(a.sessionFile ?? '')),
    )
    return { ...first!, copies: rest.length }
  })
}

export function canViewStoredArtifact(key: string, hosts: HostsSnapshot): boolean {
  if (!key.startsWith('host:')) return true
  const host = hosts[key.slice(5).split('/')[0] ?? '']
  return host?.state === 'ready' && host.capabilities.includes('artifacts.read')
}
