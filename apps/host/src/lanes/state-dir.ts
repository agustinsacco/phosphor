import {
  constants,
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

export class StateFailure extends Error {
  constructor(
    readonly directory: string,
    readonly exitCode: 70 | 78,
    detail: string,
  ) {
    super(`Host state in ${directory}: ${detail}`)
  }
}

/** Relative XDG_STATE_HOME is ignored, on Linux and macOS alike. */
export function hostStateDirectory(env: NodeJS.ProcessEnv, home: string): string {
  const state = env.XDG_STATE_HOME
  return join(state && isAbsolute(state) ? state : join(home, '.local', 'state'), 'phosphor-host')
}

export function prepareStateDirectory(directory: string, uid: number | undefined): void {
  const create = (path: string): void => {
    try {
      lstatSync(path)
      return
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    create(dirname(path))
    try {
      mkdirSync(path, { mode: 0o700 })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return
      throw error
    }
    // umask may remove owner permissions too. Restore before making a child.
    chmodSync(path, 0o700)
  }
  try {
    create(directory)
  } catch (error) {
    if (!(
      error instanceof Error &&
      'code' in error &&
      (error.code === 'EEXIST' || error.code === 'ENOTDIR' || error.code === 'ELOOP')
    ))
      throw error
    throw new StateFailure(
      directory,
      78,
      'Unsafe storage. Use an owned directory, no symlink, chmod 700.',
    )
  }
  const info = lstatSync(directory)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    uid === undefined ||
    info.uid !== uid ||
    info.mode & 0o077
  )
    throw new StateFailure(
      directory,
      78,
      'Unsafe storage. Use an owned directory, no symlink, chmod 700.',
    )
}

/** Create before SQLite opens it, so even umask 0 cannot expose state. */
export function prepareStateFile(directory: string, uid: number | undefined): string {
  const path = join(directory, 'state.sqlite')
  let file: number
  let created = false
  try {
    file = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    )
    created = true
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || info.mode & 0o077)
      throw new StateFailure(
        directory,
        78,
        'Unsafe state.sqlite. Use an owned regular file, no symlink, chmod 600.',
      )
    file = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  }
  try {
    if (created) fchmodSync(file, 0o600)
    const info = fstatSync(file)
    if (!info.isFile() || info.uid !== uid || info.mode & 0o077)
      throw new StateFailure(
        directory,
        78,
        'Unsafe state.sqlite. Use an owned regular file, no symlink, chmod 600.',
      )
  } finally {
    closeSync(file)
  }
  // SQLite also opens these files. Refuse unsafe leftovers before enabling WAL.
  for (const suffix of ['-wal', '-shm']) {
    try {
      const info = lstatSync(path + suffix)
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || info.mode & 0o077)
        throw new StateFailure(
          directory,
          78,
          'Unsafe SQLite sidecar. Use owned regular files, no symlinks, chmod 600.',
        )
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  return path
}
