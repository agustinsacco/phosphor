import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  writeSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export const HOST_PATH_BLOCK = `
# >>> Phosphor Host PATH >>>
case ":$PATH:" in
  *:"$HOME/.local/bin":*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
# <<< Phosphor Host PATH <<<
`
const MAX_RC_BYTES = 1024 * 1024
const NOFOLLOW = constants.O_NOFOLLOW | constants.O_NONBLOCK
const marker = '# >>> Phosphor Host PATH >>>'
const codeOf = (error: unknown) =>
  error instanceof Error && 'code' in error ? error.code : undefined
const unsafe = (error: unknown) =>
  ['ENOENT', 'ELOOP', 'EACCES', 'EPERM', 'ENXIO', 'EISDIR'].includes(String(codeOf(error)))

/** A concurrent growth cannot turn a bounded file check into an unbounded read. */
function readBounded(fd: number): Buffer | null {
  const bytes = Buffer.alloc(MAX_RC_BYTES + 1)
  let size = 0
  while (size < bytes.length) {
    const count = readSync(fd, bytes, size, bytes.length - size, size)
    if (count === 0) break
    size += count
  }
  return size > MAX_RC_BYTES ? null : bytes.subarray(0, size)
}
function writeAll(fd: number, bytes: Buffer): void {
  let written = 0
  while (written < bytes.length) {
    const count = writeSync(fd, bytes, written, bytes.length - written)
    if (count === 0) throw new Error('Could not write shell startup file')
    written += count
  }
}
function openAppend(path: string): number {
  const flags = constants.O_RDWR | constants.O_APPEND | NOFOLLOW
  try {
    return openSync(path, flags)
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error
  }
  try {
    return openSync(path, flags | constants.O_CREAT | constants.O_EXCL, 0o644)
  } catch (error) {
    // A file appeared after the first open. Admit it through the same safe open once.
    if (codeOf(error) !== 'EEXIST') throw error
    return openSync(path, flags)
  }
}

/** Installer-only entry: all destinations come from the local process, never CLI paths. */
export function installHostPath(context: {
  home: string
  uid: number | undefined
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  print(line: string): void
}): void {
  const { home, uid, env, print } = context
  if (
    uid === undefined ||
    env.PHOSPHOR_NO_MODIFY_PATH === '1' ||
    (env.PATH ?? '').split(':').includes(join(home, '.local/bin'))
  )
    return
  const shell = env.SHELL?.split('/').at(-1)
  const files = shell === 'zsh' ? ['.zshrc'] : shell === 'bash' ? ['.bashrc'] : []
  if (shell === 'bash' && context.platform === 'darwin') files.push('.profile')
  for (const name of files) {
    const path = join(home, name)
    let fd: number | undefined
    try {
      fd = openAppend(path)
      const info = fstatSync(fd)
      const bytes =
        info.isFile() && info.uid === uid && info.size <= MAX_RC_BYTES ? readBounded(fd) : null
      if (!bytes) {
        print(`Left unsafe shell startup file unchanged: ${path}`)
        continue
      }
      if (bytes.includes(marker)) continue
      const block = Buffer.from(HOST_PATH_BLOCK)
      if (bytes.length + block.length > MAX_RC_BYTES) {
        print(`Left unsafe shell startup file unchanged: ${path}`)
        continue
      }
      writeAll(fd, block)
      print(`Added Phosphor Host PATH to ${path}`)
    } catch (error) {
      print(
        `${unsafe(error) ? 'Left unsafe shell startup file unchanged' : 'Could not update shell startup file'}: ${path}`,
      )
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
}

function unlinkStaging(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error
  }
}

/** Atomically remove every exact block; never rewrite the opened rc file in place. */
export function removeHostPathBlocks(home: string, uid: number | undefined): void {
  if (uid === undefined) return
  for (const name of ['.zshrc', '.bashrc', '.profile']) {
    const path = join(home, name)
    let fd: number | undefined
    let tempFd: number | undefined
    let temp: string | undefined
    try {
      fd = openSync(path, constants.O_RDONLY | NOFOLLOW)
      const info = fstatSync(fd)
      if (!info.isFile() || info.uid !== uid || info.size > MAX_RC_BYTES) continue
      const before = readBounded(fd)
      if (!before) continue
      const block = Buffer.from(HOST_PATH_BLOCK)
      const parts: Buffer[] = []
      let offset = 0
      let start: number
      while ((start = before.indexOf(block, offset)) >= 0) {
        parts.push(before.subarray(offset, start))
        offset = start + block.length
      }
      if (offset === 0) continue
      parts.push(before.subarray(offset))
      const replacement = join(home, `.phosphor-rc-${randomUUID()}.tmp`)
      tempFd = openSync(
        replacement,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
        0o600,
      )
      temp = replacement
      writeAll(tempFd, Buffer.concat(parts))
      // Keep the rc's owner and group; if they cannot be kept, the original stays untouched.
      fchownSync(tempFd, info.uid, info.gid)
      fchmodSync(tempFd, info.mode & 0o7777)
      fsyncSync(tempFd)
      closeSync(tempFd)
      tempFd = undefined
      const current = lstatSync(path)
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.uid !== uid ||
        current.dev !== info.dev ||
        current.ino !== info.ino
      )
        continue
      renameSync(temp, path)
    } catch (error) {
      if (!unsafe(error)) throw error
    } finally {
      try {
        if (tempFd !== undefined) closeSync(tempFd)
      } finally {
        try {
          if (fd !== undefined) closeSync(fd)
        } finally {
          if (temp) unlinkStaging(temp)
        }
      }
    }
  }
}
