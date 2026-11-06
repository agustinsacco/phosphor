import { describe, expect, it, vi } from 'vitest'

const persisted = vi.hoisted(() => ({ data: {} as Record<string, unknown> }))

// An in-memory electron-store: the real one needs a running Electron app.
vi.mock('electron-store', () => ({
  default: class {
    private data: Record<string, unknown>
    constructor(options: { defaults: Record<string, unknown> }) {
      this.data = structuredClone(options.defaults)
      if ('agentDirectives' in options.defaults) persisted.data = this.data
    }
    get(key: string): unknown {
      return this.data[key]
    }
    set(key: string, value: unknown): void {
      this.data[key] = value
    }
    delete(key: string): void {
      delete this.data[key]
    }
  },
}))

const { getPrefs, repointStoredPaths, setPinnedSessions, setRewoundSessions } =
  await import('./store')

describe('rewoundSessions', () => {
  it('survives a folder rename the way pinnedSessions does', () => {
    const oldDir = '/agent/sessions/--box-sandbox-1--'
    const newDir = '/agent/sessions/--box-games--'
    const from = '2026-10-05T21-43-15-764Z_01a10e05.jsonl'
    const to = '2026-10-10T14-43-40-659Z_01a12645.jsonl'
    setPinnedSessions([`${oldDir}/${to}`])
    setRewoundSessions({ [from]: to })

    repointStoredPaths([
      { from: '/box/sandbox-1', to: '/box/games' },
      { from: oldDir, to: newDir },
    ])

    const prefs = getPrefs()
    expect(prefs.pinnedSessions).toEqual([`${newDir}/${to}`])
    // Keyed by file name, so it still names the moved transcripts as is.
    expect(prefs.rewoundSessions).toEqual({ [from]: to })
  })
})

it('keeps remote client account ids in a separate main-only store', async () => {
  const { randomUUID } = await import('node:crypto')
  const { getRemoteClients, setRemoteClients } = await import('./store')
  const user = randomUUID(),
    clientId = randomUUID()
  setRemoteClients({ [user]: { clientId, label: 'Viewer' } })
  expect(getRemoteClients()[user]?.clientId).toBe(clientId)
  expect(getPrefs()).not.toHaveProperty('remoteClients')
  expect(JSON.stringify(getPrefs())).not.toContain(user)
})

it('defaults legacy global and project machine awareness on, dropping retired free text', () => {
  getPrefs()
  const legacy = { worktreeGuard: false, laneCharter: false, subagentPolicy: false, custom: '' }
  persisted.data.agentDirectives = legacy
  persisted.data.agentDirectivesByProject = { '/legacy-project': legacy }
  const prefs = getPrefs()
  expect(prefs.agentDirectives.machineAwareness).toBe(true)
  expect(prefs.agentDirectivesByProject['/legacy-project']?.machineAwareness).toBe(true)
  expect(prefs.agentDirectives).not.toHaveProperty('custom')
  expect(prefs.agentDirectivesByProject['/legacy-project']).not.toHaveProperty('custom')
})

it('reads Host folder collapse keys back verbatim, never as a path under the working directory', async () => {
  const { mkdirSync, mkdtempSync, realpathSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { setCollapsedWorkspaces } = await import('./store')
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'phosphor-store-')))
  const key = 'host:h1/repo:r1'
  // A relative path spelled like the key, which realpath would resolve.
  mkdirSync(join(root, key), { recursive: true })
  const cwd = process.cwd()
  process.chdir(root)
  try {
    setCollapsedWorkspaces([key])
    expect(getPrefs().collapsedWorkspaces).toEqual([key])
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})
