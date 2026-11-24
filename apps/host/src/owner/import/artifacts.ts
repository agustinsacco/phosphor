/**
 * The `artifacts` section: Desktop's artifact store (`blobs/`, `sessions/`)
 * cloned into `<state>/artifacts` (reconcile-v2 #4). APFS clones share blocks
 * until either side writes; elsewhere it is a plain copy. The source is only
 * read and stays frozen. Every index copied is verified by hash, so a resume
 * past the 32 MiB first-scan cap and a deleted session's artifacts survive.
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import type { MigrationImporter } from '../migrate'
import type { ImportPorts } from './ports'
import { keepNames, removeAddedNames } from './snapshot'

/** The store's own names: content-addressed blobs and per-session indexes. */
const PARTS = {
  blobs: /^[0-9a-f]{64}$/,
  sessions: /^[0-9A-Za-z-]{8,128}\.json$/,
} as const

const hashOf = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return []
    throw error
  }
}

interface CopyCounts {
  copied: string[]
  kept: number
  skipped: number
}

/** Clones each store file the daemon lacks; a file it has stays the daemon's. */
async function cloneFiles(from: string, to: string, pattern: RegExp, counts: CopyCounts) {
  await mkdir(to, { recursive: true, mode: 0o700 })
  for (const name of await names(from)) {
    const source = join(from, name)
    if (!pattern.test(name) || !(await lstat(source)).isFile()) {
      counts.skipped++
      continue
    }
    const target = join(to, name)
    try {
      await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
      counts.copied.push(name)
    } catch (error) {
      if (!errnoIs(error, 'EEXIST')) throw error
      if ((await hashOf(source)) !== (await hashOf(target))) counts.kept++
    }
  }
}

export function artifactImporter(ports: ImportPorts): MigrationImporter<'artifacts'> {
  const root = join(ports.stateDirectory, 'artifacts')
  return {
    async apply({ sourceDir }) {
      let indexes: string[] = []
      const counts: CopyCounts = { copied: [], kept: 0, skipped: 0 }
      for (const [part, pattern] of Object.entries(PARTS)) {
        counts.copied = []
        await cloneFiles(join(sourceDir, part), join(root, part), pattern, counts)
        if (part === 'sessions') indexes = counts.copied
      }
      for (const name of indexes)
        if (
          (await hashOf(join(sourceDir, 'sessions', name))) !==
          (await hashOf(join(root, 'sessions', name)))
        )
          throw new Error('An artifact index changed while it was copied.')
      ports.log('owner.migrate.artifacts', {
        indexes: indexes.length,
        kept: counts.kept,
        skipped: counts.skipped,
      })
    },
    snapshot: (into) => keepNames(root, into, 'artifacts'),
    restore: (from) => removeAddedNames(root, from, 'artifacts'),
  }
}
