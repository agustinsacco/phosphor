import { lstatSync } from 'node:fs'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { basename, dirname, join } from 'node:path'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { parseMigrationFolders, type MigrationSection } from '@phosphor/shared/host-protocol-owner'
import { isPinnedPath } from './schema'
import { readSidecar, writeSidecar } from './sidecar'

export type OwnerFolders = Omit<Extract<MigrationSection, { section: 'folders' }>, 'section'> & {
  version: 1
}

function parse(raw: Record<string, unknown>): OwnerFolders | null {
  const parsed = parseMigrationFolders(raw)
  if (raw.version !== 1 || !parsed || parsed.items.length > HOST_LIMITS.repositoriesPerHost)
    return null
  const paths = [
    ...parsed.items.map((i) => i.path),
    ...(parsed.sandboxRoot ? [parsed.sandboxRoot] : []),
  ]
  if (paths.some((p) => !isPinnedPath(p) || dirname(p) === p)) return null
  const { section: _section, ...file } = parsed
  return { version: 1, ...file }
}

export function readOwnerFolders(directory: string, uid: number | undefined) {
  try {
    lstatSync(join(directory, HOST_SIDECARS.folders))
  } catch (e) {
    if (errnoIs(e, 'ENOENT')) return null
    throw e
  }
  const result = readSidecar(directory, HOST_SIDECARS.folders, parse, { uid, maxBytes: 512 * 1024 })
  if (result.state === 'invalid') throw new Error('Owner folders are not usable.')
  return result.state === 'ok' ? result.value : null
}

export function writeOwnerFolders(directory: string, uid: number | undefined, file: OwnerFolders) {
  if (!parse(file)) throw new Error('Invalid owner folders.')
  readOwnerFolders(directory, uid) // Never replace a corrupt or unsafe sidecar.
  writeSidecar(directory, HOST_SIDECARS.folders, file, {
    uid,
    known: ['version', 'items', 'sandboxRoot'],
    maxBytes: 512 * 1024,
  })
}

export function ownerFolderPaths(file: OwnerFolders) {
  return [...file.items].sort((a, b) => a.order - b.order).map((i) => i.path)
}

export function activeFolderPaths(
  file: OwnerFolders | null,
  configured: readonly string[],
  local: boolean,
) {
  if (!file) return [...configured]
  return [...new Set([...(local ? [] : configured), ...ownerFolderPaths(file)])]
}

/** Apply only the legacy list's change. Owner-only slots keep their relative order and metadata. */
export function mergeLegacyFolderChange(
  file: OwnerFolders | null,
  previous: readonly string[],
  next: readonly string[],
  local: boolean,
) {
  let snapshot: OwnerFolders | null = null
  if (file && local) {
    const byPath = new Map(file.items.map((i) => [i.path, i]))
    const kept = ownerFolderPaths(file).filter((p) => !previous.includes(p) || next.includes(p))
    const ordered = next.filter((p) => kept.includes(p) || !previous.includes(p))
    let slot = 0
    const paths = [
      ...kept.map((p) => (next.includes(p) ? ordered[slot++]! : p)),
      ...ordered.slice(slot),
    ]
    snapshot = {
      ...file,
      items: paths.map((path, order) => ({
        name: basename(path),
        ...byPath.get(path),
        path,
        order,
      })),
    }
  }
  const paths = activeFolderPaths(snapshot ?? file, next, local)
  if (paths.length > HOST_LIMITS.repositoriesPerHost) throw new Error('Folder limit reached.')
  return { paths, snapshot }
}
