import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComposerDraftRecord } from '@shared/models'

const persisted = vi.hoisted(() => ({
  userData: 'original',
  seed: {} as Record<string, unknown>,
  data: {} as Record<string, unknown>,
  constructions: [] as { name?: string; userData: string }[],
  deleted: [] as string[],
}))

vi.mock('electron-store', () => ({
  default: class {
    private data: Record<string, unknown>
    constructor(options: { defaults: Record<string, unknown>; name?: string }) {
      persisted.constructions.push({ name: options.name, userData: persisted.userData })
      this.data = { ...structuredClone(options.defaults), ...structuredClone(persisted.seed) }
      if (!options.name) persisted.data = this.data
    }
    get(key: string): unknown {
      return this.data[key]
    }
    set(key: string, value: unknown): void {
      this.data[key] = value
    }
    delete(key: string): void {
      persisted.deleted.push(key)
      delete this.data[key]
    }
  },
}))

let root: string
beforeEach(() => {
  vi.resetModules()
  persisted.userData = 'original'
  persisted.seed = {}
  persisted.data = {}
  persisted.constructions = []
  persisted.deleted = []
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'phosphor-store-')))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function folder(name: string): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return path
}
function draft(key: string, workspacePath: string): ComposerDraftRecord {
  return { key, workspacePath, text: 'unsent', attachments: [], updatedAt: 1 }
}

describe('store public contract', () => {
  it('constructs stores only on first use after the userData redirect', async () => {
    const store = await import('./store')
    expect(persisted.constructions).toEqual([])
    persisted.userData = 'redirected'
    store.getPrefs()
    store.getPrefs()
    expect(persisted.constructions).toEqual([{ name: undefined, userData: 'redirected' }])
    store.getRemoteClients()
    store.getRemoteClients()
    expect(persisted.constructions).toEqual([
      { name: undefined, userData: 'redirected' },
      { name: 'remote-clients', userData: 'redirected' },
    ])
  })

  it('migrates legacy preferences and removes retired switches once', async () => {
    persisted.seed = { claudeAutocompact: ' 120k ', accountPreview: true, machinesPreview: true }
    const store = await import('./store')
    expect(store.getPrefs().contextBudget).toBe('120k')
    expect(persisted.data).not.toHaveProperty('claudeAutocompact')
    expect(persisted.data).not.toHaveProperty('accountPreview')
    expect(persisted.data).not.toHaveProperty('machinesPreview')
    expect(persisted.deleted).toEqual(['claudeAutocompact', 'accountPreview', 'machinesPreview'])
    store.getPrefs()
    expect(persisted.deleted).toEqual(['claudeAutocompact', 'accountPreview', 'machinesPreview'])
  })

  it('adopts a symlink in place without reordering or stranding drafts', async () => {
    const store = await import('./store')
    const first = folder('first')
    const target = store.realPathOrNull(folder('target'))!
    const last = folder('last')
    const alias = join(root, 'alias')
    symlinkSync(target, alias)
    store.setRecentWorkspaces(
      [first, alias, target, last].map((path) => ({ path, name: 'old', lastOpenedAt: 0 })),
    )
    store.setDraft(draft(`home:${alias}`, alias))
    store.setCollapsedWorkspaces([alias])
    store.recordWorkspace(alias, 'alias')
    const prefs = store.getPrefs()
    expect(prefs.recentWorkspaces.map(({ path }) => path)).toEqual([first, target, last])
    expect(prefs.recentWorkspaces[1]?.name).toBe('target')
    expect(prefs.lastWorkspacePath).toBe(target)
    expect(prefs.collapsedWorkspaces).toEqual([target])
    expect(prefs.drafts).toEqual({ [`home:${target}`]: draft(`home:${target}`, target) })
    expect(persisted.data.recentWorkspaces).toEqual(prefs.recentWorkspaces)
  })

  it('repoints subtree paths and draft suffixes but leaves sibling prefixes and rewind names', async () => {
    const store = await import('./store')
    store.getPrefs()
    const from = folder('old')
    const to = folder('new')
    const session = `${from}/nested/session.jsonl`
    const nextSession = `${to}/nested/session.jsonl`
    Object.assign(persisted.data, {
      recentWorkspaces: [{ path: from, name: 'old', lastOpenedAt: 1 }],
      lastWorkspacePath: from,
      lastSessionPath: session,
      pinnedSessions: [session, `${from}-sibling/session.jsonl`],
      sessionOrder: [session],
      collapsedWorkspaces: [from],
      seenSessions: { [session]: 12 },
      laneMarkers: { [session]: 'x' },
      agentDirectivesByProject: { [from]: { custom: 'hello' } },
      rewoundSessions: { 'before.jsonl': 'after.jsonl' },
      drafts: {
        [`home:${from}`]: draft(`home:${from}`, from),
        [`session:${session}`]: draft(`session:${session}`, from),
        [session]: draft(session, from),
      },
    })
    store.repointStoredPaths([{ from, to }])
    expect(persisted.data).toMatchObject({
      recentWorkspaces: [{ path: to, name: 'new', lastOpenedAt: 1 }],
      lastWorkspacePath: to,
      lastSessionPath: nextSession,
      pinnedSessions: [nextSession, `${from}-sibling/session.jsonl`],
      sessionOrder: [nextSession],
      collapsedWorkspaces: [to],
      seenSessions: { [nextSession]: 12 },
      laneMarkers: { [nextSession]: 'x' },
      agentDirectivesByProject: { [to]: { custom: 'hello' } },
      rewoundSessions: { 'before.jsonl': 'after.jsonl' },
    })
    expect(persisted.data.drafts).toEqual({
      [`home:${to}`]: draft(`home:${to}`, to),
      [`session:${nextSession}`]: draft(`session:${nextSession}`, to),
      [nextSession]: draft(nextSession, to),
    })
  })

  it('clears both resume paths when the owning workspace is removed', async () => {
    const store = await import('./store')
    const removed = folder('removed')
    const kept = folder('kept')
    store.recordWorkspace(removed, 'removed')
    store.setLastSession(`${removed}/session.jsonl`)
    store.setRecentWorkspaces([{ path: kept, name: 'kept', lastOpenedAt: 1 }])
    expect(store.getPrefs().lastWorkspacePath).toBeUndefined()
    expect(store.getPrefs().lastSessionPath).toBeUndefined()
    expect(persisted.data).not.toHaveProperty('lastWorkspacePath')
    expect(persisted.data).not.toHaveProperty('lastSessionPath')
  })

  it('never exposes remote account identities in renderer preferences', async () => {
    const store = await import('./store')
    const user = randomUUID()
    const clients = { [user]: { clientId: randomUUID(), label: 'Viewer' } }
    store.setRemoteClients(clients)
    expect(store.getRemoteClients()).toEqual(clients)
    expect(store.getPrefs()).not.toHaveProperty('remoteClients')
    expect(JSON.stringify(store.getPrefs())).not.toContain(user)
    expect(persisted.data).not.toHaveProperty('remoteClients')
  })
})
