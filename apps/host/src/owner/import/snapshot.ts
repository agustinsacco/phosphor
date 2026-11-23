/**
 * Begin-snapshot helpers for importers that write outside state.sqlite. A
 * file is kept as its bytes and mode, or as absent; a folder as the names it
 * held, so abort removes exactly what the import added and nothing older.
 */
import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'

type KeptFile = { readonly absent: true } | { readonly mode: number; readonly bytes: string }

const keptPath = (into: string, name: string) => join(into, `${name}.kept.json`)

async function readIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return null
    throw error
  }
}

/** Records `path` as it is now under `into`, by `name`. */
export async function keepFile(path: string, into: string, name: string): Promise<void> {
  const bytes = await readIfPresent(path)
  const kept: KeptFile =
    bytes === null
      ? { absent: true }
      : { mode: (await lstat(path)).mode & 0o777, bytes: bytes.toString('base64') }
  await writeFile(keptPath(into, name), JSON.stringify(kept), { mode: 0o600, flag: 'wx' })
}

/** Same-folder temp, fsync, rename: a crash leaves the old file or the new one. */
async function replaceFile(path: string, bytes: Buffer, mode: number): Promise<void> {
  const temp = join(dirname(path), `.${randomUUID()}.restore`)
  try {
    const handle = await open(temp, 'wx', mode)
    try {
      await handle.writeFile(bytes)
      await handle.chmod(mode)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}

/** Puts `path` back as `keepFile` recorded it. A missing record throws: abort must not guess. */
export async function putBackFile(path: string, from: string, name: string): Promise<void> {
  const kept = JSON.parse(await readFile(keptPath(from, name), 'utf8')) as KeptFile
  if ('absent' in kept) await rm(path, { force: true })
  else await replaceFile(path, Buffer.from(kept.bytes, 'base64'), kept.mode)
}

/** Every file under `dir`, as paths relative to it; a missing folder holds none. */
export async function filesUnder(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true })
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return []
    throw error
  }
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort()
}

/** Records which files `dir` holds now. */
export async function keepNames(dir: string, into: string, name: string): Promise<void> {
  await writeFile(keptPath(into, name), JSON.stringify(await filesUnder(dir)), {
    mode: 0o600,
    flag: 'wx',
  })
}

/** Removes every file under `dir` that `keepNames` did not record. */
export async function removeAddedNames(dir: string, from: string, name: string): Promise<void> {
  const kept = new Set(JSON.parse(await readFile(keptPath(from, name), 'utf8')) as string[])
  for (const file of await filesUnder(dir))
    if (!kept.has(file)) await rm(join(dir, file), { force: true })
}
