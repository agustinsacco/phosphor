import { constants } from 'node:fs'
import { cp, lstat, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { renamePath, requireMissing } from './fs-service'

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}

/** Copy imports may originate outside the workspace; moves may not. Never merge/replace. */
export async function transferEntry(
  workspace: string,
  source: string,
  directory: string,
  mode: 'copy' | 'move',
): Promise<string> {
  if (mode !== 'copy' && mode !== 'move') throw new Error('Invalid transfer mode')
  const root = await realpath(workspace)
  const dir = await realpath(directory)
  const from = await realpath(source)
  if (!inside(root, dir) || !inside(resolve(workspace), resolve(directory))) {
    throw new Error('Destination must be inside the workspace')
  }
  if (!(await lstat(dir)).isDirectory()) throw new Error('Destination is not a folder')
  if (mode === 'move' && (!inside(root, from) || from === root)) {
    throw new Error('Only entries inside this workspace can be moved')
  }
  if (relative(root, dir).split(sep).includes('.git') || basename(source) === '.git') {
    throw new Error('Git metadata cannot be transferred')
  }
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
    for (let n = 1; ; n++) {
      target = join(directory, `${stem} copy${n === 1 ? '' : ` ${n}`}${ext}`)
      try {
        await lstat(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
        throw error
      }
    }
  }
  await requireMissing(target)
  if (mode === 'move') {
    // No copy+delete fallback: a failed/cross-device move must keep the source intact.
    await renamePath(source, target)
  } else {
    await cp(source, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      mode: constants.COPYFILE_EXCL,
      verbatimSymlinks: true,
    })
  }
  return target
}
