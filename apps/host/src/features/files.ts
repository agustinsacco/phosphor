import { access, constants, realpath, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { walkFiles } from '@phosphor/session-runtime/files/walk'
import { git } from '@phosphor/session-runtime/git/git-exec'
import { FILE_LIMITS, isFilePath, type FileRead } from '@phosphor/shared/host-protocol-files'
import type { CallErrorCode } from '@phosphor/shared/host-protocol'
import type { FeatureContext, FeatureOutcome, HostFeature } from './feature'
import { errnoIs, isInside } from '../fs-safety'
import { queryFiles } from './files/query'
import { validateList } from './files/validate-list'

export class FileFailure extends Error {
  constructor(readonly code: CallErrorCode) {
    super(code)
  }
}
export function inside(root: string, path: string): boolean {
  return isInside(resolve(root), resolve(path))
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
        if (missing && error instanceof Error && errnoIs(error, 'ENOENT')) break
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
  await validateList(files, (file) => checkedPath(root, file, true))
  return files
}
/** Entries one walk may read, ignored and skipped ones included: ten per listed file. */
const WALK_ENTRIES = FILE_LIMITS.entries * 10
/**
 * A configured folder without git lists as Desktop's file finder does: the first
 * 20,000 files past dependency, build and cache files and folders and hidden
 * folders, links left out, within an entry budget. A name no file path can carry is left out too. Every
 * listed path is then checked as a git list is, so a folder swapped for a link
 * mid-walk refuses the list rather than naming what lies outside.
 */
export async function filePaths(root: string): Promise<string[]> {
  try {
    await safeGit(root, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    // The walk skips folders it cannot read; a root it cannot read is a failure.
    await access(root, constants.R_OK | constants.X_OK)
    const walked = await walkFiles(root, FILE_LIMITS.entries, { entries: WALK_ENTRIES })
    const files = walked.files.filter(isFilePath)
    await validateList(files, (file) => checkedPath(root, file, true))
    return files.sort()
  }
  return listedPaths(root)
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
  const ports = {
    laneRoot,
    filePaths,
    checkedPath,
    readResult,
    failure,
    error: (code: CallErrorCode) => new FileFailure(code),
  }
  return {
    capability: 'workspaces.read',
    methods: ['files.list', 'files.read'],
    call: (method, params) => queryFiles(context, method, params, ports),
  }
}
