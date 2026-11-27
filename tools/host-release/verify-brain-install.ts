import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  type Stats,
} from 'node:fs'
import { join } from 'node:path'
import { HOST_RELEASE_VERSION_PATTERN, hostReleaseFileMode } from '@phosphor/shared/host-release'
import { resolvePackagedBrainRuntime } from '../../apps/host/src/brain/packaged-runtime'

const READ_FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const left = Buffer.alloc(64 * 1024)
const right = Buffer.alloc(left.length)

/** Both paths have passed lstat; never read from a link, special file or a larger file. */
function sameBytes(expected: string, installed: string, size: number): boolean {
  const a = openSync(expected, READ_FILE)
  try {
    const b = openSync(installed, READ_FILE)
    try {
      const info = fstatSync(b)
      if (!info.isFile() || info.nlink !== 1 || info.size !== size) return false
      for (let offset = 0; offset < size; offset += left.length) {
        const length = Math.min(left.length, size - offset)
        if (
          readSync(a, left, 0, length, offset) !== length ||
          readSync(b, right, 0, length, offset) !== length ||
          !left.subarray(0, length).equals(right.subarray(0, length))
        )
          return false
      }
      return true
    } finally {
      closeSync(b)
    }
  } finally {
    closeSync(a)
  }
}

/**
 * The two extractors of one signed archive. The shell installer's tar runs under umask 077, so
 * its modes are those of the verified extraction itself. `phosphor update` writes fixed modes
 * into a mkdtemp folder: 0700 at the version root, 0755 folders and the release's file modes.
 */
type InstalledMode = (relative: string, expected: Stats) => number
const extractedMode: InstalledMode = (_relative, expected) => expected.mode
const updaterMode: InstalledMode = (relative, expected) =>
  (expected.mode & constants.S_IFMT) |
  (relative === '' ? 0o700 : expected.isDirectory() ? 0o755 : hostReleaseFileMode(relative))

/** Compare from the bounded signed tree, rejecting aliases, changed modes and extra entries. */
function sameTree(
  expected: string,
  installed: string,
  modeOf: InstalledMode,
  relative = '',
): boolean {
  const a = lstatSync(expected)
  const b = lstatSync(installed)
  if (modeOf(relative, a) !== b.mode || b.uid !== process.getuid?.()) return false
  if (a.isDirectory() && b.isDirectory()) {
    const names = readdirSync(expected)
    const found = new Set(readdirSync(installed))
    return (
      names.length === found.size &&
      names.every(
        (name) =>
          found.has(name) &&
          sameTree(
            join(expected, name),
            join(installed, name),
            modeOf,
            relative ? `${relative}/${name}` : name,
          ),
      )
    )
  }
  return (
    a.isFile() &&
    b.isFile() &&
    b.nlink === 1 &&
    a.size === b.size &&
    sameBytes(expected, installed, a.size)
  )
}

/** Invoked under the installer lock, with Node from the freshly signature/hash-verified archive. */
export function verifyBrainInstall(
  unpacked: string,
  root: string,
  version: string,
  launcher: string,
): boolean {
  try {
    if (!resolvePackagedBrainRuntime(join(unpacked, 'lib'))) return false
    const current = join(root, 'current')
    const command = lstatSync(launcher, { throwIfNoEntry: false })
    if (
      command &&
      (!command.isSymbolicLink() || readlinkSync(launcher) !== join(current, 'bin/phosphor'))
    )
      return false

    let target: string | undefined
    const pointer = lstatSync(current, { throwIfNoEntry: false })
    if (pointer) {
      if (!pointer.isSymbolicLink()) return false
      target = readlinkSync(current)
      if (
        !target.startsWith('versions/') ||
        !HOST_RELEASE_VERSION_PATTERN.test(target.slice('versions/'.length))
      )
        return false
      const folder = lstatSync(join(root, target), { throwIfNoEntry: false })
      if (folder ? !folder.isDirectory() : target !== `versions/${version}`) return false
    }

    const existing = join(root, 'versions', version)
    if (!lstatSync(existing, { throwIfNoEntry: false })) return true
    // One whole tree per extractor: a mix of the two layouts is drift, not a copy.
    return (
      (!target || target === `versions/${version}`) &&
      (sameTree(unpacked, existing, extractedMode) || sameTree(unpacked, existing, updaterMode))
    )
  } catch {
    return false
  }
}
