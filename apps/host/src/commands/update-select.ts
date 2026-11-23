import {
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { HOST_RELEASE_VERSION_PATTERN } from '@phosphor/shared/host-release'
import { compareVersions, UpdateFailure } from '@phosphor/session-runtime/host-install/fetch'
import { atomicRecord, readBounded } from '@phosphor/session-runtime/host-install/files'
import type { InstalledLayout } from '@phosphor/session-runtime/host-install/layout'

/** A complete release folder under `versions/`, named by its own VERSION file. */
export function installedVersion(layout: InstalledLayout, version: unknown): version is string {
  if (typeof version !== 'string' || !HOST_RELEASE_VERSION_PATTERN.test(version)) return false
  try {
    const folder = join(layout.lib, 'versions', version)
    if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) return false
    return (
      readBounded(join(folder, 'VERSION'), 32).replace(/\n+$/, '') === version &&
      ['bin/phosphor', 'node/bin/node', 'lib/phosphor.mjs'].every(
        (name) =>
          lstatSync(join(folder, name)).isFile() &&
          realpathSync(join(folder, name)) === join(folder, name),
      )
    )
  } catch {
    return false
  }
}
export function selectVersion(layout: InstalledLayout, current: string, previous: string): void {
  const link = join(layout.lib, `.current-${process.pid}`)
  const before = readlinkSync(layout.current)
  try {
    symlinkSync(`versions/${current}`, link)
    renameSync(link, layout.current)
    try {
      atomicRecord(join(layout.lib, 'install.json'), { current, previous }, 0o644)
    } catch (error) {
      symlinkSync(before, link)
      renameSync(link, layout.current)
      throw error
    }
  } finally {
    rmSync(link, { force: true })
  }
}

/** Keeps current, previous and the newest other installed release. */
export function prune(layout: InstalledLayout, current: string, previous: string): void {
  const names = readdirSync(join(layout.lib, 'versions'))
  if (names.length > 4096) throw new UpdateFailure('Too many installed versions.')
  const older = names
    .filter((v) => v !== current && v !== previous && installedVersion(layout, v))
    .sort((a, b) => compareVersions(b, a))
  for (const version of older.slice(1))
    rmSync(join(layout.lib, 'versions', version), { recursive: true })
}
