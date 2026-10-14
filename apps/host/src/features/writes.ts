import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, link, unlink } from 'node:fs/promises'
import { dirname, join, relative, sep, basename } from 'node:path'
import { FILE_LIMITS, isFilePath } from '@phosphor/shared/host-protocol-files'
import { parseFileWriteOp, type FileWriteOp } from '@phosphor/shared/host-protocol-writes'
import {
  filesystemCode,
  renameNoReplace,
  transferEntry,
} from '@phosphor/session-runtime/files/mutations'
import type { RejectCode } from '@phosphor/shared/host-protocol'
import type { FeatureContext } from './feature'
import { laneRoot, inside } from './files'

class WriteFailure extends Error {
  constructor(readonly code: RejectCode) {
    super(code)
  }
}
/** Node lacks openat. Refuse all symlinks, then recheck immediately before mutation.
 * A same-user actor can still replace an ancestor between check and syscall.
 */
export async function mutationPath(root: string, path: string, missing = false): Promise<string> {
  if (!isFilePath(path)) throw new WriteFailure('bad-request')
  let current = root
  const components = path.split('/')
  for (let i = 0; i < components.length; i++) {
    current = join(current, components[i] ?? '')
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || (i < components.length - 1 && !info.isDirectory()))
        throw new WriteFailure('bad-request')
    } catch (error) {
      if (!(missing && i === components.length - 1 && filesystemCode(error) === 'ENOENT'))
        throw error
    }
  }
  if ((await realpath(root)) !== root || (await realpath(dirname(current))) !== dirname(current))
    throw new WriteFailure('bad-request')
  return current
}
async function revision(path: string): Promise<string | null> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await handle.stat()
    if (!info.isFile()) throw new WriteFailure('bad-request')
    if (info.size > FILE_LIMITS.textBytes) throw new WriteFailure('bad-request')
    const bytes = Buffer.alloc(FILE_LIMITS.textBytes + 1)
    let count = 0
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, count)
      if (!result.bytesRead) break
      count += result.bytesRead
    }
    if (count > FILE_LIMITS.textBytes) throw new WriteFailure('bad-request')
    return createHash('sha256').update(bytes.subarray(0, count)).digest('hex')
  } catch (error) {
    if (filesystemCode(error) === 'ENOENT') return null
    throw error
  } finally {
    await handle?.close()
  }
}
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
export type WriteOutcome = { ok: true; data?: unknown } | { ok: false; code: RejectCode }
export function createWrites(context: FeatureContext) {
  return {
    capabilityFor(type: string) {
      return type.startsWith('files.') &&
        ['files.write', 'files.create', 'files.rename', 'files.delete', 'files.transfer'].includes(
          type,
        )
        ? ('workspaces.write' as const)
        : null
    },
    async execute(laneId: string, input: FileWriteOp): Promise<WriteOutcome> {
      const op = parseFileWriteOp(input)
      if (!op) return { ok: false, code: 'bad-request' }
      try {
        const root = await laneRoot(context, laneId)
        if (op.type === 'files.write') {
          const target = await mutationPath(root, op.path, true)
          if ((await revision(target)) !== op.expected) throw new WriteFailure('conflict')
          const temp = join(dirname(target), `.phosphor-write-${randomUUID()}`)
          await mutationPath(root, op.path, true)
          const mode = op.expected === null ? 0o600 : (await lstat(target)).mode & 0o777
          const file = await open(temp, 'wx', mode)
          try {
            try {
              await file.writeFile(op.content, 'utf8')
              await file.sync()
            } finally {
              await file.close()
            }
            await mutationPath(root, op.path, true)
            if ((await revision(target)) !== op.expected) throw new WriteFailure('conflict')
            await mutationPath(root, op.path, true)
            // Existing files have a same-user final hash-to-rename window.
            if (op.expected === null) await link(temp, target)
            else await rename(temp, target)
            return {
              ok: true,
              data: {
                revision: createHash('sha256').update(op.content).digest('hex'),
                mtimeMs: (await lstat(target)).mtimeMs,
              },
            }
          } finally {
            await unlink(temp).catch((error: unknown) => {
              if (filesystemCode(error) !== 'ENOENT') throw error
            })
          }
        }
        if (op.type === 'files.create') {
          const target = await mutationPath(root, op.path, true)
          if (op.kind === 'directory') await mkdir(target)
          else {
            const file = await open(target, 'wx', 0o600)
            await file.close()
          }
          return { ok: true }
        }
        if (op.type === 'files.rename') {
          const from = await mutationPath(root, op.from)
          const to = await mutationPath(root, op.to, true)
          if (inside(from, to)) throw new WriteFailure('bad-request')
          await mutationPath(root, op.from)
          await renameNoReplace(from, to)
          return { ok: true }
        }
        if (op.type === 'files.transfer') {
          const source = await mutationPath(root, op.source)
          const directory = op.directory === '.' ? root : await mutationPath(root, op.directory)
          let entries = 0
          const path = await transferEntry(
            root,
            source,
            directory,
            op.mode,
            async (path, missing) => {
              if (++entries > 40000 || !inside(root, path)) throw new WriteFailure('bad-request')
              if (path !== root)
                await mutationPath(root, relative(root, path).split(sep).join('/'), missing)
            },
          )
          return { ok: true, data: { path: relative(root, path).split(sep).join('/') } }
        }
        const target = await mutationPath(root, op.path)
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
          await mutationPath(root, op.path)
          // No EXDEV copy/delete fallback. Unique destination never replaces another item.
          await trashParent(files)
          await renameNoReplace(target, join(files, name))
        } catch (error) {
          if (infoPath) await unlink(infoPath)
          throw error
        }
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          code:
            error instanceof WriteFailure
              ? error.code
              : filesystemCode(error) === 'EEXIST'
                ? 'conflict'
                : 'bad-request',
        }
      }
    },
  }
}
