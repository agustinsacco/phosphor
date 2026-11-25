import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from 'node:fs'
import { join } from 'node:path'

export const spawnHelperDirs: readonly string[] = [
  'build/Release',
  'build/Debug',
  `prebuilds/${process.platform}-${process.arch}`,
]

/** Only repair an owned, single-link helper at its physical location in the resolved package. */
export function repairSpawnHelper(packageRoot: string, dir: string): boolean {
  try {
    const uid = process.geteuid?.()
    if (uid === undefined || !spawnHelperDirs.includes(dir)) return false
    const root = realpathSync(packageRoot)
    if (root !== packageRoot) return false
    const helper = join(root, dir, 'spawn-helper')
    const before = lstatSync(helper)
    if (!before.isFile() || before.nlink !== 1 || before.uid !== uid || before.mode & 0o100)
      return false
    if (realpathSync(helper) !== helper) return false

    const fd = openSync(helper, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const file = fstatSync(fd)
      if (
        !file.isFile() ||
        file.uid !== uid ||
        file.nlink !== 1 ||
        file.mode & 0o100 ||
        file.dev !== before.dev ||
        file.ino !== before.ino ||
        realpathSync(helper) !== helper
      )
        return false
      fchmodSync(fd, (file.mode & 0o777) | 0o755)
      return true
    } finally {
      closeSync(fd)
    }
  } catch {
    // Missing, read-only or changed during inspection: let node-pty report any spawn failure.
    return false
  }
}
