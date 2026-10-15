import { randomUUID } from 'node:crypto'
import { lstat, open, opendir, realpath, unlink } from 'node:fs/promises'
import { renameSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import {
  parseFolderParams,
  isHomePath,
  type RepositoryOp,
  type FolderList,
} from '@phosphor/shared/host-protocol-repositories'
import type { RejectCode, RepositorySummary } from '@phosphor/shared/host-protocol'
import { loadHostConfig, CONFIG_MAX_BYTES } from '../config/load'
import { validateRepositoryIdentity, type RepositoryIdentity, type HostStore } from '../lanes/store'
import { inside, FileFailure, failure } from './files'
import type { HostFeature } from './feature'

export async function homeDirectory(
  home: string,
  path: string,
): Promise<{ root: string; full: string; path: string }> {
  if (!isHomePath(path)) throw new FileFailure('bad-request')
  const root = await realpath(home)
  const full = await realpath(join(root, path))
  if (!inside(root, full) || !(await lstat(full)).isDirectory())
    throw new FileFailure('bad-request')
  const canonical = relative(root, full)
  if (!isHomePath(canonical)) throw new FileFailure('bad-request')
  return { root, full, path: canonical }
}
export function createRepositories(options: {
  home: string
  configPath: string
  uid: number | undefined
  store: HostStore
  live(repositoryId: string): boolean
  changed(roots: readonly string[]): void
}) {
  async function config() {
    const loaded = await loadHostConfig(options.configPath, options.uid)
    if (!loaded.ok || loaded.config.allowRepositoryChanges === false)
      throw new FileFailure('forbidden')
    return loaded
  }
  async function save(
    repositories: string[],
    allowed: () => boolean,
    identity?: RepositoryIdentity,
  ) {
    const loaded = await config()
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
  const feature: HostFeature = {
    capability: 'workspaces.write',
    methods: ['machine.folders.list'],
    async call(_method, params) {
      const p = parseFolderParams(params)
      if (!p) return failure(new FileFailure('bad-request'))
      try {
        await config()
        const folder = await homeDirectory(options.home, p.path ?? '')
        const configured = new Set(options.store.listRepositories().map((r) => r.path))
        const entries: FolderList['entries'] = []
        let truncated = false
        let scanned = 0
        const directory = await opendir(folder.full)
        for await (const entry of directory) {
          if (++scanned > 20000) {
            truncated = true
            break
          }
          if (!entry.isDirectory() || entry.name.startsWith('.') || !isHomePath(entry.name))
            continue
          if (entries.length === 500) {
            truncated = true
            break
          }
          const full = await realpath(join(folder.full, entry.name))
          if (!inside(folder.root, full)) continue
          const isRepository = await lstat(join(full, '.git')).then(
            (s) => s.isDirectory() || s.isFile(),
            () => false,
          )
          entries.push({ name: entry.name, isRepository, configured: configured.has(full) })
        }
        await config()
        entries.sort((a, b) => a.name.localeCompare(b.name))
        return { ok: true, data: { path: folder.path, entries, truncated } }
      } catch (error) {
        return failure(error)
      }
    },
  }
  return {
    feature,
    async execute(
      op: RepositoryOp,
      allowed: () => boolean,
    ): Promise<{ ok: true; data?: RepositorySummary } | { ok: false; code: RejectCode }> {
      try {
        const loaded = await config()
        if (!allowed()) return { ok: false, code: 'forbidden' }
        let paths = [...loaded.config.repositories]
        if (op.type === 'host.repositories.add') {
          const folder = await homeDirectory(options.home, op.path)
          const info = await lstat(folder.full)
          const existing = await Promise.all(paths.map((p) => realpath(p).catch(() => p)))
          if (existing.includes(folder.full)) return { ok: false, code: 'conflict' }
          if (paths.length >= 64) return { ok: false, code: 'too-many-requests' }
          paths.push(folder.full)
          const summaries = await save(paths, allowed, {
            home: options.home,
            expected: { path: folder.full, dev: info.dev, ino: info.ino },
          })
          const added = summaries.find((r) => r.path === folder.full)
          if (!added) throw new Error('repository unavailable')
          return { ok: true, data: added }
        }
        const repository = options.store.listRepositories().find((r) => r.id === op.repositoryId)
        if (!repository) return { ok: false, code: 'bad-request' }
        if (options.live(repository.id)) return { ok: false, code: 'busy' }
        const canonical = await Promise.all(paths.map((p) => realpath(p).catch(() => p)))
        paths = paths.filter((_p, i) => canonical[i] !== repository.path)
        // Config v1 requires at least one repository.
        if (!paths.length) return { ok: false, code: 'last-repository' }
        if (!allowed() || options.live(repository.id)) return { ok: false, code: 'busy' }
        await save(paths, () => allowed() && !options.live(repository.id))
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          code:
            error instanceof FileFailure && error.code === 'forbidden'
              ? 'forbidden'
              : 'bad-request',
        }
      }
    },
  }
}
