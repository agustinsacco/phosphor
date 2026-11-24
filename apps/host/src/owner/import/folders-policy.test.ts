import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readOwnerFolders, writeOwnerFolders } from '../../config/folders-file'
import { OwnerCallRefused } from '../adapter'
import { scratchHost, snapshotFolder, uid, type ScratchHost } from './__fixtures__/scratch-host'
import { FOLDER_REFUSALS, folderImporter } from './folders'
import { POLICY_REFUSALS, policyImporter } from './policy'

let host: ScratchHost
beforeEach(async () => {
  host = await scratchHost()
})
afterEach(() => host.close())

const directives = {
  machineAwareness: true,
  worktreeGuard: false,
  laneCharter: true,
  subagentPolicy: false,
}

describe('folders', () => {
  const foldersFile = () => join(host.root, 'config', 'folders.json')

  it('imports folders in order, with sandbox flags and root, and the store follows', async () => {
    const a = host.folder('a')
    const b = host.folder('b')
    const sandboxRoot = host.folder('sandboxes')
    const items = [
      { path: b, name: 'b', order: 1, sandbox: true as const },
      { path: a, name: 'a', order: 0 },
    ]
    await folderImporter(host.ports).apply(
      { section: 'folders', items, sandboxRoot },
      host.context(),
    )
    expect(readOwnerFolders(join(host.root, 'config'), uid)).toEqual({
      version: 1,
      items: [
        { path: a, name: 'a', order: 0 },
        { path: b, name: 'b', order: 1, sandbox: true },
      ],
      sandboxRoot,
    })
    expect(host.store.listRepositories().map((r) => r.path)).toEqual([a, b])
  })

  it('merges after the daemon’s own folders, keeping its order and sandbox root', async () => {
    const own = host.folder('own')
    const shared = host.folder('shared')
    const mac = host.folder('mac')
    writeOwnerFolders(join(host.root, 'config'), uid, {
      version: 1,
      items: [
        { path: shared, name: 'shared', order: 1 },
        { path: own, name: 'own', order: 0 },
      ],
      sandboxRoot: own,
    })
    await folderImporter(host.ports).apply(
      {
        section: 'folders',
        items: [
          { path: mac, name: 'mac', order: 0 },
          { path: shared, name: 'shared', order: 1 },
        ],
        sandboxRoot: mac,
      },
      host.context(true),
    )
    const file = readOwnerFolders(join(host.root, 'config'), uid)
    expect(file?.items.map((i) => [i.path, i.order])).toEqual([
      [own, 0],
      [shared, 1],
      [mac, 2],
    ])
    expect(file?.sandboxRoot).toBe(own)
  })

  it('refuses more than 64 folders before writing anything', async () => {
    const items = Array.from({ length: 65 }, (_, i) => ({
      path: host.folder(`f${i}`),
      name: `f${i}`,
      order: i,
    }))
    const imported = folderImporter(host.ports).apply({ section: 'folders', items }, host.context())
    await expect(imported).rejects.toEqual(
      new OwnerCallRefused('too-large', FOLDER_REFUSALS.tooMany),
    )
    expect(existsSync(foldersFile())).toBe(false)
    expect(host.store.listRepositories()).toEqual([])
  })

  it('abort puts folders.json back as it was: removed when absent, bytes when present', async () => {
    const importer = folderImporter(host.ports)
    const absent = snapshotFolder(host, 'folders-absent')
    await importer.snapshot!(absent)
    const items = [{ path: host.folder('a'), name: 'a', order: 0 }]
    await importer.apply({ section: 'folders', items }, host.context())
    await importer.restore!(absent)
    expect(existsSync(foldersFile())).toBe(false)

    await importer.apply({ section: 'folders', items }, host.context())
    const before = readFileSync(foldersFile())
    const present = snapshotFolder(host, 'folders-present')
    await importer.snapshot!(present)
    await importer.apply(
      { section: 'folders', items: [{ path: host.folder('b'), name: 'b', order: 0 }] },
      host.context(),
    )
    await importer.restore!(present)
    expect(readFileSync(foldersFile())).toEqual(before)
  })
})

describe('policy', () => {
  const section = {
    section: 'policy' as const,
    contextBudget: '300k',
    agentDirectives: directives,
    directivesByFolder: { '/work/a': { ...directives, laneCharter: false } },
    autoNameLanes: false,
    contextFiles: { claude: false, agents: true },
    headroom: true,
  }
  const config = () => JSON.parse(readFileSync(host.config, 'utf8')) as Record<string, unknown>
  const headroom = () => join(host.state, 'headroom.json')

  it('writes budget, naming and directives into the config and the Headroom switch', async () => {
    await policyImporter(host.ports).apply(section, host.context())
    expect(config()).toMatchObject({
      contextBudget: '300k',
      contextFiles: section.contextFiles,
      autoNameLanes: false,
      agentDirectives: directives,
      agentDirectivesByProject: section.directivesByFolder,
      repositories: [],
    })
    expect(JSON.parse(readFileSync(headroom(), 'utf8'))).toMatchObject({ enabled: true })
  })

  it('merge fills only what the daemon has not set, Headroom included', async () => {
    writeFileSync(
      host.config,
      JSON.stringify({
        version: 1,
        pi: { executable: '/usr/bin/pi' },
        repositories: [],
        autoNameLanes: true,
        contextFiles: { claude: true, agents: false },
        agentDirectivesByProject: { '/work/a': directives },
      }),
      { mode: 0o600 },
    )
    writeFileSync(headroom(), JSON.stringify({ version: 1, enabled: false }), { mode: 0o600 })
    await policyImporter(host.ports).apply(section, host.context(true))
    expect(config()).toMatchObject({
      contextBudget: '300k',
      autoNameLanes: true,
      contextFiles: { claude: true, agents: false },
      agentDirectivesByProject: { '/work/a': directives },
    })
    expect(JSON.parse(readFileSync(headroom(), 'utf8'))).toMatchObject({ enabled: false })
  })

  it('refuses a policy the Host config would not accept, leaving the config alone', async () => {
    const before = readFileSync(host.config)
    await expect(
      policyImporter(host.ports).apply({ ...section, contextBudget: 'lots' }, host.context()),
    ).rejects.toEqual(new OwnerCallRefused('bad-request', POLICY_REFUSALS.invalid))
    expect(readFileSync(host.config)).toEqual(before)
    expect(existsSync(headroom())).toBe(false)
  })

  it('abort puts the config and the Headroom switch back byte for byte', async () => {
    const importer = policyImporter(host.ports)
    const before = readFileSync(host.config)
    const folder = snapshotFolder(host, 'policy')
    await importer.snapshot!(folder)
    await importer.apply(section, host.context())
    await importer.restore!(folder)
    expect(readFileSync(host.config)).toEqual(before)
    expect(existsSync(headroom())).toBe(false)
  })
})
