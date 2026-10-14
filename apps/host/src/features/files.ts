import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { join, relative, isAbsolute, sep } from 'node:path'
import { git } from '@phosphor/session-runtime/git/git-exec'
import {
  FILE_LIMITS,
  isFilePath,
  parseFileParams,
  type FileRead,
} from '@phosphor/shared/host-protocol-files'
import type { CallErrorCode } from '@phosphor/shared/host-protocol'
import type { FeatureContext, FeatureOutcome, HostFeature } from './feature'

export class FileFailure extends Error {
  constructor(readonly code: CallErrorCode) {
    super(code)
  }
}
export function inside(root: string, path: string): boolean {
  const r = relative(root, path)
  return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`))
}
export async function laneRoot(context: FeatureContext, laneId: string): Promise<string> {
  const lane = context.store.getLane(laneId)
  const repo = lane && context.store.listRepositories().find((r) => r.id === lane.repositoryId)
  if (!lane || lane.removedAt !== null || !repo) throw new FileFailure('unknown-lane')
  try {
    const root = await realpath(lane.cwd)
    if (
      !inside(await realpath(repo.path), root) ||
      root.split(sep).some((s) => s.toLowerCase() === '.git') ||
      !(await stat(root)).isDirectory()
    )
      throw new FileFailure('unknown-lane')
    return root
  } catch {
    throw new FileFailure('unknown-lane')
  }
}
export async function checkedPath(root: string, path: string, missing = false): Promise<string> {
  if (!isFilePath(path)) throw new FileFailure('bad-request')
  const full = join(root, path)
  try {
    // Check every component, including aliases of .git and parent symlinks.
    let current = root
    for (const part of path.split('/')) {
      current = join(current, part)
      try {
        const resolved = await realpath(current)
        if (
          !inside(root, resolved) ||
          relative(root, resolved)
            .split(sep)
            .some((s) => s.toLowerCase() === '.git')
        )
          throw new FileFailure('bad-request')
      } catch (error) {
        if (missing && error instanceof Error && 'code' in error && error.code === 'ENOENT') break
        throw error
      }
    }
    return full
  } catch {
    throw new FileFailure('bad-request')
  }
}
export const safeGit = async (cwd: string, args: string[], maxBuffer?: number) => {
  try {
    return await git(cwd, ['--no-pager', '-c', 'core.fsmonitor=false', ...args], {
      isolateEnv: true,
      // Disable Git's lazy fetching of missing objects.
      env: {
        GIT_LITERAL_PATHSPECS: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_COUNT: '0',
        GIT_NO_LAZY_FETCH: '1',
      },
      ...(maxBuffer === undefined ? {} : { maxBuffer }),
    })
  } catch (error) {
    if (
      maxBuffer !== undefined &&
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    )
      throw new FileFailure('too-large')
    throw error
  }
}
export async function listedPaths(root: string, path = '.'): Promise<string[]> {
  const out = await safeGit(root, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    path,
  ])
  const files = [...new Set(out.split('\0').filter(Boolean))]
  if (files.length > FILE_LIMITS.entries) throw new FileFailure('too-large')
  for (const file of files) await checkedPath(root, file, true)
  return files
}
export function readResult(bytes: Buffer, size = bytes.length): FileRead {
  if (bytes.includes(0)) return { binary: true, size }
  if (size > FILE_LIMITS.textBytes) throw new FileFailure('too-large')
  const content = bytes.toString('utf8')
  if (Buffer.byteLength(content) > FILE_LIMITS.textBytes) throw new FileFailure('too-large')
  return { binary: false, size, content }
}
export function failure(error: unknown): FeatureOutcome {
  const code = error instanceof FileFailure ? error.code : 'internal'
  const message =
    code === 'bad-request'
      ? 'Invalid file request.'
      : code === 'unknown-lane'
        ? 'Lane is unavailable.'
        : code === 'too-large'
          ? 'Result exceeds the limit.'
          : 'File query failed.'
  return { ok: false, error: { code, message } }
}
export function createFilesFeature(context: FeatureContext): HostFeature {
  return {
    capability: 'workspaces.read',
    methods: ['files.list', 'files.read'],
    async call(method, params) {
      const p = parseFileParams(method, params)
      if (!p || !['files.list', 'files.read'].includes(method))
        return failure(new FileFailure('bad-request'))
      try {
        const root = await laneRoot(context, p.laneId)
        if (method === 'files.list') {
          const files = await listedPaths(root)
          return { ok: true, data: { files } }
        }
        if (!p.path) throw new FileFailure('bad-request')
        const full = await checkedPath(root, p.path, true)
        const before = await lstat(full)
        if (!before.isFile()) throw new FileFailure('bad-request')
        const handle = await open(
          full,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        )
        try {
          const after = await handle.stat()
          if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino)
            throw new FileFailure('bad-request')
          await checkedPath(root, p.path)
          const current = await lstat(full)
          if (current.dev !== after.dev || current.ino !== after.ino)
            throw new FileFailure('bad-request')
          const bytes = Buffer.alloc(Math.min(after.size + 1, FILE_LIMITS.textBytes + 1))
          let count = 0
          while (count < bytes.length) {
            const r = await handle.read(bytes, count, bytes.length - count, count)
            if (!r.bytesRead) break
            count += r.bytesRead
          }
          return {
            ok: true,
            data: {
              ...readResult(bytes.subarray(0, count), Math.max(after.size, count)),
              revision: createHash('sha256').update(bytes.subarray(0, count)).digest('hex'),
            },
          }
        } finally {
          await handle.close()
        }
      } catch (error) {
        if (
          method === 'files.read' &&
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return { ok: true, data: { binary: false, size: 0, content: '', revision: null } }
        const result = failure(error)
        context.log('feature-query', {
          laneId: p.laneId,
          method,
          reason: result.ok ? 'ok' : result.error.code,
        })
        return result
      }
    },
  }
}
