import { constants } from 'node:fs'
import { cp, lstat, realpath, link, unlink, rename, mkdir, readdir, chmod } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export function filesystemCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined
}
export async function requireMissing(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (filesystemCode(error) === 'ENOENT') return
    throw error
  }
  throw Object.assign(new Error('Already exists'), { code: 'EEXIST' })
}
/** Files use atomic no-replace. Directory rename has a same-user check-to-use window. */
export async function renameNoReplace(from: string, to: string): Promise<void> {
  const info = await lstat(from)
  if (info.isFile()) {
    await link(from, to)
    await unlink(from)
  } else if (info.isDirectory()) {
    await requireMissing(to)
    await rename(from, to)
  } else throw new Error('Only files and folders can be transferred')
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}
/** Copy imports may originate outside the workspace; moves may not. Never merge/replace.
 * Remote callers supply a guard that refuses symlinks and rechecks parents before I/O.
 */
export async function transferEntry(
  workspace: string,
  source: string,
  directory: string,
  mode: 'copy' | 'move',
  guard?: (path: string, missing?: boolean) => Promise<void>,
): Promise<string> {
  if (mode !== 'copy' && mode !== 'move') throw new Error('Invalid transfer mode')
  const root = await realpath(workspace)
  const dir = await realpath(directory)
  const from = await realpath(source)
  if (!inside(root, dir) || !inside(resolve(workspace), resolve(directory)))
    throw new Error('Destination must be inside the workspace')
  if (!(await lstat(dir)).isDirectory()) throw new Error('Destination is not a folder')
  if (mode === 'move' && (!inside(root, from) || from === root))
    throw new Error('Only entries inside this workspace can be moved')
  if (relative(root, dir).split(sep).includes('.git') || basename(source) === '.git')
    throw new Error('Git metadata cannot be transferred')
  const info = await lstat(source)
  if (!info.isFile() && !info.isDirectory())
    throw new Error('Only files and folders can be transferred')
  if (info.isDirectory() && inside(from, dir))
    throw new Error('A folder cannot be placed inside itself')
  let target = join(directory, basename(source))
  if (dir === dirname(from)) {
    if (mode === 'move') return source
    const ext = info.isDirectory() ? '' : extname(source)
    const stem = basename(source, ext)
    // Bound hostile directories containing many copy names.
    for (let n = 1; n <= 20000; n++) {
      target = join(directory, `${stem} copy${n === 1 ? '' : ` ${n}`}${ext}`)
      try {
        await requireMissing(target)
        break
      } catch (error) {
        if (filesystemCode(error) !== 'EEXIST' || n === 20000) throw error
      }
    }
  }
  await requireMissing(target)
  await guard?.(source)
  await guard?.(target, true)
  if (mode === 'move') await renameNoReplace(source, target)
  else {
    // Reserve directories atomically so recursive cp cannot merge into a racing create.
    if (info.isDirectory()) await mkdir(target)
    const options = {
      recursive: true,
      force: false,
      errorOnExist: true,
      mode: constants.COPYFILE_EXCL,
      verbatimSymlinks: true,
      ...(guard
        ? {
            filter: async (src: string, dest: string) => {
              await guard(src)
              await guard(dest, true)
              return true
            },
          }
        : {}),
    }
    if (info.isDirectory()) {
      for (const child of await readdir(source))
        await cp(join(source, child), join(target, child), options)
      await chmod(target, info.mode)
    } else await cp(source, target, options)
  }
  return target
}
