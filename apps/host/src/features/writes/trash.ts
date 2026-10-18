import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { dirname, join, relative, sep, basename } from 'node:path'
import { filesystemCode, renameNoReplace } from '@phosphor/session-runtime/files/mutations'
import type { FeatureContext } from '../feature'
import { mutationPath, WriteFailure } from './guards'

/** Trash ancestors are outside the lane, but must obey the same no-symlink rule. */
async function trashDirectory(path: string): Promise<void> {
  const parent = dirname(path)
  if (parent !== path) await trashDirectory(parent)
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (filesystemCode(error) !== 'EEXIST') throw error
  }
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new WriteFailure('bad-request')
}
async function trashParent(path: string): Promise<void> {
  if ((await realpath(path)) !== path) throw new WriteFailure('bad-request')
}
function deletionDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
export async function trashEntry(
  context: FeatureContext,
  root: string,
  path: string,
): Promise<void> {
  const target = await mutationPath(root, path)
  const home = await realpath(context.home)
  const dataHome = context.env.XDG_DATA_HOME?.startsWith(context.home + sep)
    ? join(home, relative(context.home, context.env.XDG_DATA_HOME))
    : context.env.XDG_DATA_HOME || join(home, '.local', 'share')
  const trash = process.platform === 'darwin' ? join(home, '.Trash') : join(dataHome, 'Trash')
  const files = process.platform === 'darwin' ? trash : join(trash, 'files')
  await trashDirectory(files)
  const name = `${randomUUID()}-${basename(target)}`
  let infoPath: string | undefined
  if (process.platform !== 'darwin') {
    const info = join(trash, 'info')
    await trashDirectory(info)
    infoPath = join(info, `${name}.trashinfo`)
    await trashParent(info)
    const file = await open(infoPath, 'wx', 0o600)
    try {
      try {
        await file.writeFile(
          `[Trash Info]\nPath=${encodeURIComponent(target)}\nDeletionDate=${deletionDate(new Date())}\n`,
        )
        await file.sync()
      } finally {
        await file.close()
      }
    } catch (error) {
      await unlink(infoPath)
      throw error
    }
  }
  try {
    await mutationPath(root, path)
    // No EXDEV copy/delete fallback. Unique destination never replaces another item.
    await trashParent(files)
    await renameNoReplace(target, join(files, name))
  } catch (error) {
    if (infoPath) await unlink(infoPath)
    throw error
  }
}
