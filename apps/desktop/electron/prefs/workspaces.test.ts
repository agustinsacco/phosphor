import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrefsGetter } from './backend'
import {
  isWorktreeFolder,
  realPathOrNull,
  recordWorkspace,
  repointStoredPaths,
  resolvedOrSame,
  setCollapsedWorkspaces,
  setLastSession,
  setRecentWorkspaces,
} from './workspaces'

const resolved = vi.hoisted(() => new Map<string, string>())
vi.mock('node:fs', () => ({
  realpathSync: {
    native: (path: string): string => {
      const real = resolved.get(path)
      if (!real) throw new Error('missing folder')
      return real
    },
  },
}))
vi.mock('electron-store', () => ({
  default: class {
    private data: Record<string, unknown>
    constructor(options: { defaults: Record<string, unknown> }) {
      this.data = structuredClone(options.defaults)
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

let getStore: PrefsGetter
beforeEach(async () => {
  vi.resetModules()
  resolved.clear()
  getStore = (await import('./backend')).prefs
})

const workspace = (path: string) => ({ path, name: path.slice(1), lastOpenedAt: 1 })

describe('workspace preferences', () => {
  it('uses native realpath and retains missing or unset paths when requested', () => {
    resolved.set('/alias', '/real')
    expect(realPathOrNull('/alias')).toBe('/real')
    expect(realPathOrNull('/missing')).toBeNull()
    expect(resolvedOrSame('/alias')).toBe('/real')
    expect(resolvedOrSame('/missing')).toBe('/missing')
    expect(resolvedOrSame(undefined)).toBeUndefined()
    expect(isWorktreeFolder('/repo/.phosphor/worktrees/lane')).toBe(true)
    expect(isWorktreeFolder('C:\\repo\\.pidex\\worktrees\\lane')).toBe(true)
    expect(isWorktreeFolder('/repo/worktrees/lane')).toBe(false)
  })

  it('adopts duplicate spellings at their first position and carries keyed state', () => {
    resolved.set('/alias', '/real')
    resolved.set('/real', '/real')
    const s = getStore()
    s.set('recentWorkspaces', ['/first', '/alias', '/real', '/last'].map(workspace))
    s.set('collapsedWorkspaces', ['/alias'])
    s.set('drafts', {
      'home:/alias': {
        key: 'home:/alias',
        text: 'unsent',
        workspacePath: '/alias',
        attachments: [],
        updatedAt: 1,
      },
    })
    recordWorkspace(getStore, '/alias', 'alias')
    expect(s.get('recentWorkspaces').map(({ path }) => path)).toEqual(['/first', '/real', '/last'])
    expect(s.get('collapsedWorkspaces')).toEqual(['/real'])
    expect(s.get('drafts')).toEqual({
      'home:/real': {
        key: 'home:/real',
        text: 'unsent',
        workspacePath: '/real',
        attachments: [],
        updatedAt: 1,
      },
    })
    expect(s.get('lastWorkspacePath')).toBe('/real')
  })

  it('caps newly appended recents at twenty without moving existing entries', () => {
    const s = getStore()
    s.set(
      'recentWorkspaces',
      Array.from({ length: 20 }, (_, i) => workspace(`/folder-${i}`)),
    )
    recordWorkspace(getStore, '/new', 'new')
    const paths = s.get('recentWorkspaces').map(({ path }) => path)
    expect(paths).toEqual([...Array.from({ length: 19 }, (_, i) => `/folder-${i + 1}`), '/new'])
    recordWorkspace(getStore, '/folder-10', 'ignored')
    expect(s.get('recentWorkspaces').map(({ path }) => path)).toEqual(paths)
  })

  it.each(['.phosphor', '.pidex'])(
    'remembers %s worktree resume without adding a recent',
    (segment) => {
      const path = `/repo/${segment}/worktrees/lane`
      recordWorkspace(getStore, path, 'lane')
      expect(getStore().get('recentWorkspaces')).toEqual([])
      expect(getStore().get('lastWorkspacePath')).toBe(path)
    },
  )

  it('clears removed owners but preserves a resume target in a kept nested workspace', () => {
    const s = getStore()
    s.set('recentWorkspaces', ['/repo', '/repo/nested'].map(workspace))
    s.set('lastWorkspacePath', '/repo/nested/.phosphor/worktrees/lane')
    setLastSession(getStore, '/sessions/lane.jsonl')
    setRecentWorkspaces(getStore, [workspace('/repo/nested')])
    expect(s.get('lastSessionPath')).toBe('/sessions/lane.jsonl')
    setRecentWorkspaces(getStore, [])
    expect(s.get('lastWorkspacePath')).toBeUndefined()
    expect(s.get('lastSessionPath')).toBeUndefined()
  })

  it('stores collapsed paths verbatim and clears an explicitly closed resume session', () => {
    setCollapsedWorkspaces(getStore, ['/alias', '/missing'])
    expect(getStore().get('collapsedWorkspaces')).toEqual(['/alias', '/missing'])
    setLastSession(getStore, '/sessions/lane.jsonl')
    expect(getStore().get('lastSessionPath')).toBe('/sessions/lane.jsonl')
    setLastSession(getStore, undefined)
    expect(getStore().get('lastSessionPath')).toBeUndefined()
  })

  it('repoints every persisted path field, including colon-prefixed and bare draft keys', () => {
    const s = getStore()
    s.set('recentWorkspaces', ['/old', '/old-sibling'].map(workspace))
    s.set('lastWorkspacePath', '/old')
    s.set('lastSessionPath', '/sessions/old/lane.jsonl')
    s.set('pinnedSessions', ['/sessions/old/lane.jsonl'])
    s.set('sessionOrder', ['/sessions/old/lane.jsonl'])
    s.set('collapsedWorkspaces', ['/old'])
    s.set('seenSessions', { '/sessions/old/lane.jsonl': 1 })
    s.set('laneMarkers', { '/sessions/old/lane.jsonl': 'x' })
    s.set('agentDirectivesByProject', { '/old': { custom: 'instruction' } })
    s.set('rewoundSessions', { 'before.jsonl': 'after.jsonl' })
    const keys = ['home:/old', 'session:/sessions/old/lane.jsonl', '/old/bare', 'home:/old-sibling']
    s.set(
      'drafts',
      Object.fromEntries(
        keys.map((key) => [key, { key, text: 'draft', attachments: [], updatedAt: 1 }]),
      ),
    )
    repointStoredPaths(getStore, [
      { from: '/old', to: '/new' },
      { from: '/sessions/old', to: '/sessions/new' },
    ])
    expect(s.get('recentWorkspaces')).toEqual([workspace('/new'), workspace('/old-sibling')])
    expect(s.get('lastWorkspacePath')).toBe('/new')
    expect(s.get('lastSessionPath')).toBe('/sessions/new/lane.jsonl')
    expect(s.get('pinnedSessions')).toEqual(['/sessions/new/lane.jsonl'])
    expect(s.get('sessionOrder')).toEqual(['/sessions/new/lane.jsonl'])
    expect(s.get('collapsedWorkspaces')).toEqual(['/new'])
    expect(s.get('seenSessions')).toEqual({ '/sessions/new/lane.jsonl': 1 })
    expect(s.get('laneMarkers')).toEqual({ '/sessions/new/lane.jsonl': 'x' })
    expect(s.get('agentDirectivesByProject')).toEqual({ '/new': { custom: 'instruction' } })
    expect(s.get('rewoundSessions')).toEqual({ 'before.jsonl': 'after.jsonl' })
    expect(Object.keys(s.get('drafts'))).toEqual([
      'home:/new',
      'session:/sessions/new/lane.jsonl',
      '/new/bare',
      'home:/old-sibling',
    ])
    expect(Object.values(s.get('drafts')).every((draft) => !('workspacePath' in draft))).toBe(true)
  })
})
