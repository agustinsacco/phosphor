import { chmodSync, lstatSync } from 'node:fs'

/** Older installs may lack the execute bit. Missing/read-only helpers must not prevent startup. */
export function repairSpawnHelper(path: string): void {
  try {
    const stat = lstatSync(path)
    if (stat.isFile() && !(stat.mode & 0o111)) chmodSync(path, (stat.mode & 0o777) | 0o755)
  } catch {
    // Let node-pty report an error if it actually needs this helper.
  }
}
