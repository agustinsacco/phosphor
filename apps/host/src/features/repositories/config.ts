import { randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import { open, realpath, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CONFIG_MAX_BYTES, loadHostConfig } from '../../config/load'
import {
  validateRepositoryIdentity,
  type HostStore,
  type RepositoryIdentity,
} from '../../lanes/store'
import { FileFailure } from '../files'
import { withSettingsFileLock } from '../../settings/files'

export interface RepositoryConfigSource {
  configPath: string
  uid: number | undefined
}
export interface RepositoryConfigOptions extends RepositoryConfigSource {
  store: HostStore
  changed(roots: readonly string[]): void
}

export async function loadRepositoryConfig(options: RepositoryConfigSource) {
  const loaded = await loadHostConfig(options.configPath, options.uid)
  if (!loaded.ok || loaded.config.allowRepositoryChanges === false)
    throw new FileFailure('forbidden')
  return loaded
}

export function publishRepositoryConfig(
  options: RepositoryConfigOptions,
  repositories: string[],
  allowed: () => boolean,
  identity?: RepositoryIdentity,
) {
  return withSettingsFileLock(options.configPath, () =>
    publishUnlocked(options, repositories, allowed, identity),
  )
}

async function publishUnlocked(
  options: RepositoryConfigOptions,
  repositories: string[],
  allowed: () => boolean,
  identity?: RepositoryIdentity,
) {
  const loaded = await loadRepositoryConfig(options)
  const target = await realpath(loaded.path)
  const parent = await realpath(dirname(target))
  const bytes = JSON.stringify({ ...loaded.config, repositories }, null, 2) + '\n'
  if (Buffer.byteLength(bytes) > CONFIG_MAX_BYTES) throw new FileFailure('too-large')
  const temp = join(parent, `.config-${randomUUID()}.tmp`)
  try {
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (!allowed() || (await realpath(dirname(target))) !== parent)
      throw new FileFailure('forbidden')
    // No asynchronous seam between identity validation, commit and publication.
    if (identity) validateRepositoryIdentity(identity)
    renameSync(temp, target)
    const summaries = options.store.syncRepositories(repositories, undefined, identity)
    options.changed(summaries.map((r) => r.path))
    return summaries
  } finally {
    await unlink(temp).catch(() => {})
  }
}
