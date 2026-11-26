import { guardSandboxTranscripts } from './sandbox-transcript-guard'
import { lstatSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { HOST_LIMITS, type HostResourceChange } from '@phosphor/shared/host-protocol'
import { isWithinFolder } from '@phosphor/shared/paths'
import { isOwnerPrivate } from '@phosphor/session-runtime/fs-safety'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import {
  createSandboxFolder,
  listSandboxFolders,
  planSandboxRename,
  realOrLexical,
  resolveSandboxFolder,
} from '@phosphor/session-runtime/sandboxes/folders'
import {
  deleteSandbox,
  renameSandbox,
  type SandboxOwner,
} from '@phosphor/session-runtime/sandboxes/service'
import {
  activeFolderPaths,
  readOwnerFolders,
  writeOwnerFolders,
  type OwnerFolders,
} from '../config/folders-file'
import { loadHostConfig } from '../config/load'
import type { HostStore } from '../lanes/store'
import type { WorkspaceLeases } from '../owner/lease'

export interface SandboxPorts {
  local: boolean
  stateDirectory: string
  configPath: string
  uid: number | undefined
  home: string
  env: NodeJS.ProcessEnv
  store: HostStore
  leases: WorkspaceLeases
  live(path: string): boolean
  trashItem(path: string, owner: boolean): Promise<void>
  resourceChanged?(change: HostResourceChange): void
  changed(roots: readonly string[]): void
  /** The folder service's queue, so a sandbox write never races a folder change. */
  serialize?<T>(work: () => Promise<T>): Promise<T>
}

type Records = { file: OwnerFolders; configured: string[]; base: string }
const busy = () => new OpRefusal('busy', 'This sandbox is in use.')

function readBase(p: SandboxPorts, file: OwnerFolders | null) {
  const base = realOrLexical((p.local && file?.sandboxRoot) || join(p.stateDirectory, 'sandboxes'))
  if (base === dirname(base)) throw new Error('Unsafe sandbox root.')
  return base
}

async function records(p: SandboxPorts): Promise<Records> {
  const loaded = await loadHostConfig(p.configPath, p.uid)
  if (!loaded.ok || loaded.config.allowRepositoryChanges === false)
    throw new OpRefusal('forbidden', 'Folder changes are disabled.')
  const dir = dirname(p.configPath)
  const info = lstatSync(dir)
  if (!info.isDirectory() || !isOwnerPrivate(info, p.uid))
    throw new OpRefusal('forbidden', 'Sandbox records require an owner-private config directory.')
  const configured = loaded.config.repositories
  const file = readOwnerFolders(dir, p.uid) ?? {
    version: 1,
    items: (p.local ? configured : []).map((path, order) => ({
      path,
      name: basename(path),
      order,
    })),
  }
  return { file, configured, base: readBase(p, file) }
}

function publish(p: SandboxPorts, r: Records, items: OwnerFolders['items']) {
  const file = { ...r.file, items }
  const paths = activeFolderPaths(file, r.configured, p.local)
  writeOwnerFolders(dirname(p.configPath), p.uid, file)
  return p.store.syncRepositories(paths)
}

function publishSandboxChange(p: SandboxPorts, repos: ReturnType<HostStore['syncRepositories']>) {
  p.changed(repos.map((repository) => repository.path))
  p.resourceChanged?.({ kind: 'folders' })
  p.resourceChanged?.({ kind: 'sandboxes' })
}

function sandboxOwner(p: SandboxPorts, r: Records, path: string, owner: boolean): SandboxOwner {
  // Canonicalize aliases while the sandbox still exists, not after moving it.
  const items = r.file.items.map((i) => ({ ...i, path: realOrLexical(i.path) }))
  const repo = p.store.listRepositories().find((v) => v.path === path)
  const rows = p.store.listLanes().filter((l) => l.repositoryId === repo?.id)
  return {
    env: p.env,
    home: p.home,
    guardTranscripts: guardSandboxTranscripts,
    hasLiveFolder: p.live,
    hasArchivedFolder: async (path) => p.store.folders.hasArchivedFolder(path),
    retainedCwds: () =>
      rows
        .map((l) => l.cwd)
        .filter((cwd) => isWithinFolder(cwd, path) && realOrLexical(cwd) === cwd),
    trashItem: (file) => p.trashItem(file, owner),
    repointStoredPaths(moves) {
      const to = moves[0]!.to
      const next = items.map((i) => (i.path === path ? { ...i, path: to, name: basename(to) } : i))
      const repos = publish(p, r, next)
      const target = repos.find((v) => v.path === to)
      if (repo && target) p.store.folders.repoint(moves, repo.id, target.id)
      publishSandboxChange(p, repos)
    },
    forgetWorkspace() {
      const repos = publish(
        p,
        r,
        items.filter((i) => i.path !== path),
      )
      for (const lane of rows) p.store.markRemoved(lane.laneId)
      publishSandboxChange(p, repos)
    },
  }
}

export function createHostSandboxes(p: SandboxPorts) {
  let writing = false
  async function write<T>(run: (r: Records) => Promise<T>) {
    if (writing) throw busy()
    writing = true
    try {
      const turn = async () => run(await records(p))
      return await (p.serialize ? p.serialize(turn) : turn())
    } finally {
      writing = false
    }
  }
  return {
    list: () => listSandboxFolders(readBase(p, readOwnerFolders(dirname(p.configPath), p.uid))),
    create: (name: string) =>
      write(async (r) => {
        if (
          activeFolderPaths(r.file, r.configured, p.local).length >= HOST_LIMITS.repositoriesPerHost
        )
          throw new OpRefusal('limit', 'Folder limit reached.')
        const path = createSandboxFolder(r.base, name)
        const order = Math.max(-1, ...r.file.items.map((i) => i.order)) + 1
        const repos = publish(p, r, [
          ...r.file.items,
          { path, name: basename(path), order, sandbox: true },
        ])
        publishSandboxChange(p, repos)
        return { path }
      }),
    change: (input: string, name: string | null, owner: boolean) =>
      write(async (r) => {
        const path = resolveSandboxFolder(r.base, input)
        if (!path || !lstatSync(path).isDirectory())
          throw new OpRefusal('bad-request', 'Not a sandbox folder.')
        // Config-owned headless roots cannot be renamed out from under config.json.
        if (!p.local && r.configured.some((v) => isWithinFolder(realOrLexical(v), path)))
          throw busy()
        const plan = name !== null ? planSandboxRename(r.base, path, name) : null
        if (plan && !plan.ok) throw new OpRefusal('bad-request', plan.reason)
        const held = await p.leases.take('sandbox', plan ? [path, plan.to] : [path], Infinity)
        if (!('leaseId' in held)) throw busy()
        try {
          const guards = sandboxOwner(p, r, path, owner)
          const result =
            name === null
              ? await deleteSandbox(r.base, path, guards)
              : await renameSandbox(r.base, path, name, guards)
          if (!result.ok)
            throw new OpRefusal(result.reason === 'in-use' ? 'busy' : 'bad-request', result.reason)
          return result
        } finally {
          p.leases.release('sandbox', held.leaseId)
        }
      }),
  }
}
