import { lstat, mkdir, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { isHomePath, type RepositoryOp } from '@phosphor/shared/host-protocol-repositories'
import type { RejectCode, RepositorySummary } from '@phosphor/shared/host-protocol'
import { inside, FileFailure } from './files'
import { createFoldersFeature, type HomeFolder } from './repositories/browse'
import {
  loadRepositoryConfig,
  publishRepositoryConfig,
  type RepositoryConfigOptions,
} from './repositories/config'

export async function homeDirectory(home: string, path: string): Promise<HomeFolder> {
  if (!isHomePath(path)) throw new FileFailure('bad-request')
  const root = await realpath(home)
  const full = await realpath(join(root, path))
  if (!inside(root, full) || !(await lstat(full)).isDirectory())
    throw new FileFailure('bad-request')
  const canonical = relative(root, full)
  if (!isHomePath(canonical)) throw new FileFailure('bad-request')
  return { root, full, path: canonical }
}

interface RepositoryOptions extends RepositoryConfigOptions {
  home: string
  live(repositoryId: string): boolean
}

async function executeRepository(
  options: RepositoryOptions,
  op: RepositoryOp,
  allowed: () => boolean,
): Promise<{ ok: true; data?: RepositorySummary } | { ok: false; code: RejectCode }> {
  try {
    const loaded = await loadRepositoryConfig(options)
    if (!allowed()) return { ok: false, code: 'forbidden' }
    let paths = [...loaded.config.repositories]
    if (op.type === 'host.repositories.add') {
      const folder = await homeDirectory(options.home, op.path)
      const info = await lstat(folder.full)
      const existing = await Promise.all(paths.map((p) => realpath(p).catch(() => p)))
      if (existing.includes(folder.full)) return { ok: false, code: 'conflict' }
      if (paths.length >= 64) return { ok: false, code: 'too-many-requests' }
      paths.push(folder.full)
      const summaries = await publishRepositoryConfig(options, paths, allowed, {
        home: options.home,
        expected: { path: folder.full, dev: info.dev, ino: info.ino },
      })
      const added = summaries.find((r) => r.path === folder.full)
      if (!added) throw new Error('repository unavailable')
      return { ok: true, data: added }
    }
    if (op.type === 'host.repositories.createFolder') {
      const slash = op.path.lastIndexOf('/')
      const parent = await homeDirectory(options.home, op.path.slice(0, Math.max(slash, 0)))
      if (!allowed()) return { ok: false, code: 'forbidden' }
      // Not recursive: an existing name, file or symlink included, is a conflict.
      await mkdir(join(parent.full, op.path.slice(slash + 1)))
      return { ok: true }
    }
    if (op.type === 'host.repositories.order') return await reorder(options, op, paths, allowed)
    const repository = options.store.listRepositories().find((r) => r.id === op.repositoryId)
    if (!repository) return { ok: false, code: 'bad-request' }
    if (options.live(repository.id)) return { ok: false, code: 'busy' }
    const canonical = await Promise.all(paths.map((p) => realpath(p).catch(() => p)))
    paths = paths.filter((_p, i) => canonical[i] !== repository.path)
    if (!allowed() || options.live(repository.id)) return { ok: false, code: 'busy' }
    await publishRepositoryConfig(options, paths, () => allowed() && !options.live(repository.id))
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof FileFailure && error.code === 'forbidden'
          ? 'forbidden'
          : error instanceof Error && 'code' in error && error.code === 'EEXIST'
            ? 'conflict'
            : 'bad-request',
    }
  }
}

/**
 * Rewrite the config's repository order. The request names every active repository once; a
 * stale list (one added or removed since) is a conflict. A configured folder that is not active,
 * such as one missing on disk, keeps its place in the config.
 */
async function reorder(
  options: RepositoryOptions,
  op: Extract<RepositoryOp, { type: 'host.repositories.order' }>,
  paths: string[],
  allowed: () => boolean,
): Promise<{ ok: true } | { ok: false; code: RejectCode }> {
  const active = options.store.listRepositories()
  const byId = new Map(active.map((r) => [r.id, r.path]))
  if (op.repositoryIds.length !== active.length || !op.repositoryIds.every((id) => byId.has(id)))
    return { ok: false, code: 'conflict' }
  const canonical = await Promise.all(paths.map((p) => realpath(p).catch(() => p)))
  const wanted = op.repositoryIds.map((id) => byId.get(id)!)
  const slots = canonical.flatMap((path, i) => (wanted.includes(path) ? [i] : []))
  // Every active repository came from one config entry; anything else means the config moved.
  if (slots.length !== wanted.length) return { ok: false, code: 'conflict' }
  // Entries move as written: a symlinked spelling in the config stays as the user wrote it.
  const next = [...paths]
  slots.forEach((slot, i) => (next[slot] = paths[canonical.indexOf(wanted[i]!)]!))
  if (!allowed()) return { ok: false, code: 'forbidden' }
  await publishRepositoryConfig(options, next, allowed)
  return { ok: true }
}

export function createRepositories(options: RepositoryOptions) {
  return {
    feature: createFoldersFeature(options, homeDirectory),
    execute: (op: RepositoryOp, allowed: () => boolean) => executeRepository(options, op, allowed),
  }
}
