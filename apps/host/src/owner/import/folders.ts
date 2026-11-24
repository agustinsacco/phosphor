/**
 * The `folders` section: This Mac's recents, order and sandboxes become the
 * daemon's owner folders (`folders.json`), and the store's repositories
 * follow, so the lanes section finds each folder's repository id.
 */
import { dirname, join } from 'node:path'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import {
  activeFolderPaths,
  ownerFolderPaths,
  readOwnerFolders,
  writeOwnerFolders,
  type OwnerFolders,
} from '../../config/folders-file'
import type { MigrationImporter } from '../migrate'
import { refuseImport, type ImportPorts } from './ports'
import { keepFile, putBackFile } from './snapshot'

export const FOLDER_REFUSALS = {
  tooMany: `This Mac has more folders than the Phosphor service can hold (${HOST_LIMITS.repositoriesPerHost}).`,
} as const

type FoldersSection = Parameters<MigrationImporter<'folders'>['apply']>[0]

/** Merge keeps the daemon's folders first and appends the imported ones it lacks. */
export function importedFolders(
  section: FoldersSection,
  existing: OwnerFolders | null,
  merge: boolean,
): OwnerFolders {
  const imported = [...section.items].sort((a, b) => a.order - b.order)
  const base = merge && existing ? ownerFolderPaths(existing) : []
  const byPath = new Map(existing?.items.map((i) => [i.path, i]) ?? [])
  const items = [
    ...base.map((path) => byPath.get(path)!),
    ...imported.filter((i) => !base.includes(i.path)),
  ].map((item, order) => ({ ...item, order }))
  const sandboxRoot = (merge ? existing?.sandboxRoot : undefined) ?? section.sandboxRoot
  return { version: 1, items, ...(sandboxRoot ? { sandboxRoot } : {}) }
}

export function folderImporter(ports: ImportPorts): MigrationImporter<'folders'> {
  const directory = dirname(ports.configPath)
  const file = join(directory, HOST_SIDECARS.folders)
  return {
    async apply(section, { merge, store }) {
      const write = async () => {
        const next = importedFolders(section, readOwnerFolders(directory, ports.uid), merge)
        if (next.items.length > HOST_LIMITS.repositoriesPerHost)
          throw refuseImport('too-large', FOLDER_REFUSALS.tooMany)
        writeOwnerFolders(directory, ports.uid, next)
        // A local daemon's folders are its owner folders; the legacy list does not count.
        store.syncRepositories(activeFolderPaths(next, [], true), (count) =>
          ports.log('owner.migrate.folders_unavailable', { count }),
        )
      }
      await (ports.serialize ? ports.serialize(write) : write())
    },
    snapshot: (into) => keepFile(file, into, 'folders'),
    restore: (from) => putBackFile(file, from, 'folders'),
  }
}
