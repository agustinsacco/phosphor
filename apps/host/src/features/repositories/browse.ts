import { lstat, opendir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isHomePath,
  parseFolderParams,
  type FolderList,
} from '@phosphor/shared/host-protocol-repositories'
import type { HostFeature } from '../feature'
import { failure, FileFailure, inside } from '../files'
import { loadRepositoryConfig, type RepositoryConfigOptions } from './config'

export type HomeFolder = { root: string; full: string; path: string }

export function createFoldersFeature(
  options: Pick<RepositoryConfigOptions, 'configPath' | 'uid' | 'store'> & { home: string },
  homeDirectory: (home: string, path: string) => Promise<HomeFolder>,
): HostFeature {
  return {
    capability: 'workspaces.write',
    methods: ['machine.folders.list'],
    async call(_method, params) {
      const p = parseFolderParams(params)
      if (!p) return failure(new FileFailure('bad-request'))
      try {
        await loadRepositoryConfig(options)
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
          if (
            !entry.isDirectory() ||
            (entry.name.startsWith('.') && !p.hidden) ||
            !isHomePath(entry.name)
          )
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
        await loadRepositoryConfig(options)
        entries.sort((a, b) => a.name.localeCompare(b.name))
        return { ok: true, data: { path: folder.path, entries, truncated } }
      } catch (error) {
        return failure(error)
      }
    },
  }
}
