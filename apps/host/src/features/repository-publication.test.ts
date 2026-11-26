import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import type { HostResourceChange } from '@phosphor/shared/host-protocol'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { createLanesTopic } from '../lanes/stream'
import { openStore } from '../lanes/store'
import type { DaemonHandlerDeps } from '../ops/handlers'
import { folderHandlers } from '../ops/handlers/folders'
import { sandboxHandlers } from '../ops/handlers/sandboxes'
import { createWorkspaceLeases } from '../owner/lease'
import { createRepositories } from './repositories'
import { createHostSandboxes } from './sandboxes'

const agent = {
  kind: 'agent',
  laneRef: 'issuer',
  sessionId: 'pi',
  lineage: 0,
  unattended: false,
} as const
const surface = { kind: 'surface', clientId: 'pwa', label: 'PWA', via: 'grant' } as const
const context = (principal: OpHandlerContext['principal']): OpHandlerContext => ({
  principal,
  signal: new AbortController().signal,
  log: () => {},
})
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'host-publication-')))
  const stateDirectory = join(home, 'state')
  const configPath = join(home, 'config.json')
  const uid = process.getuid?.()
  const store = await openStore(stateDirectory, uid)
  onTestFinished(async () => {
    store.close()
    await rm(home, { recursive: true, force: true })
  })
  await writeFile(
    configPath,
    JSON.stringify({ version: 1, pi: { executable: process.execPath }, repositories: [] }),
    { mode: 0o600 },
  )
  const topic = createLanesTopic({
    epoch: '0000000000000001',
    list: () => ({ lanes: [], repositories: store.listRepositories() }),
  })
  const seen: { change: HostResourceChange; names: string[] }[] = []
  topic.listenResources((change) => {
    if (change) seen.push({ change, names: topic.snapshot().repositories.map((r) => r.name) })
  })
  const options = {
    configPath,
    home,
    uid,
    store,
    changed: () => topic.repositoriesChanged(),
    resourceChanged: topic.resourceChanged,
    live: () => false,
  }
  const repositories = createRepositories(options)
  const sandboxes = createHostSandboxes({
    ...options,
    stateDirectory,
    local: true,
    env: {},
    leases: createWorkspaceLeases(() => []),
    trashItem: (path) => rm(path, { recursive: true }),
  })
  return {
    home,
    store,
    repositories,
    sandboxes,
    seen,
    deps: { store, repositories, sandboxes } as DaemonHandlerDeps,
  }
}

it.each(['agent', 'ui'] as const)(
  'publishes committed folder inventory updates from %s',
  async (mode) => {
    const { home, store, repositories, deps, seen } = await fixture()
    await mkdir(join(home, 'one'))
    const handlers = folderHandlers(deps)
    const allowed = () => true
    if (mode === 'agent') {
      await handlers['folder.add']!({ path: 'one' }, context(agent))
      await handlers['folder.create']!({ path: 'two' }, context(agent))
    } else {
      expect(
        await repositories.execute({ type: 'host.repositories.add', path: 'one' }, allowed),
      ).toMatchObject({ ok: true })
      expect(
        await repositories.execute(
          { type: 'host.repositories.createFolder', path: 'two' },
          allowed,
        ),
      ).toMatchObject({ ok: true })
      expect(
        await repositories.execute({ type: 'host.repositories.add', path: 'two' }, allowed),
      ).toMatchObject({ ok: true })
    }
    const [one, two] = store.listRepositories().map((r) => r.id)
    const ids = [two!, one!]
    if (mode === 'agent') {
      await handlers['folder.order']!({ ids }, context(agent))
      await handlers['folder.remove']!({ id: one }, context(agent))
    } else {
      expect(
        await repositories.execute(
          { type: 'host.repositories.order', repositoryIds: ids },
          allowed,
        ),
      ).toMatchObject({ ok: true })
      expect(
        await repositories.execute(
          { type: 'host.repositories.remove', repositoryId: one! },
          allowed,
        ),
      ).toMatchObject({ ok: true })
    }
    expect(seen).toEqual(
      [['one'], ['one', 'two'], ['two', 'one'], ['two']].map((names) => ({
        change: { kind: 'folders' },
        names,
      })),
    )
  },
)

it.each([agent, surface])(
  'publishes sandbox and folder inventories from $kind ops',
  async (principal) => {
    const { deps, sandboxes, seen } = await fixture()
    const handlers = sandboxHandlers(deps)
    const run = (op: keyof typeof handlers, args: unknown) => handlers[op](args, context(principal))
    await run('sandbox.create', { name: 'scratch' })
    await run('sandbox.rename', { path: sandboxes.list()[0]!.path, name: 'renamed' })
    expect(sandboxes.list().map((row) => basename(row.path))).toEqual(['renamed'])
    await run('sandbox.delete', { path: sandboxes.list()[0]!.path })
    expect(sandboxes.list()).toEqual([])
    expect(seen).toEqual(
      [['scratch'], ['renamed'], []].flatMap((names) => [
        { change: { kind: 'folders' }, names },
        { change: { kind: 'sandboxes' }, names },
      ]),
    )
  },
)
