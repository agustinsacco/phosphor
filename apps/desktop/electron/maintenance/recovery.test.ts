import './__fixtures__/memory-history'
import { describe, expect, it, vi } from 'vitest'
import type { DEFAULT_APP_PREFS } from '@shared/models'
import { header, recoveryCases, toolCall } from './__fixtures__/recovery-cases'
import { checkoutLayout, editedCheckoutFiles, pickBranch } from './recovery'

const state = vi.hoisted(() => ({
  prefs: null as unknown as typeof DEFAULT_APP_PREFS,
  live: [] as Array<{ workspacePath: string }>,
}))
vi.mock('../store', () => ({ getPrefs: () => state.prefs }))
vi.mock('../registry', () => ({ registry: { list: () => state.live } }))
vi.mock('../pi/session-watcher', () => ({ notifyWorkspaceSessions: vi.fn() }))

describe('pure helpers', () => {
  it('accepts only the .phosphor/worktrees layout addWorktree recreates', () => {
    expect(checkoutLayout('/repo/.phosphor/worktrees/lane')).toEqual({
      repoPath: '/repo',
      name: 'lane',
    })
    expect(checkoutLayout('/repo/.phosphor/worktrees/lane/sub')).toBeNull()
    expect(checkoutLayout('/repo/.pidex/worktrees/lane')).toBeNull()
    expect(checkoutLayout('/elsewhere/lane')).toBeNull()
    expect(checkoutLayout('relative/.phosphor/worktrees/lane')).toBeNull()
    expect(checkoutLayout('/repo/.phosphor/worktrees/../lane')).toBeNull()
  })

  it('lists edit/write targets inside the checkout only', () => {
    const cwd = '/repo/.phosphor/worktrees/lane'
    const text = [
      header(cwd),
      toolCall('write', { path: `${cwd}/src/a.ts` }, 'w1'),
      toolCall('edit', { path: 'src/b.ts' }, 'e1'),
      toolCall('edit', { path: 'src/b.ts' }, 'e2'),
      toolCall('write', { path: '/tmp/scratch/progress.md' }, 'w2'),
      toolCall('write', { path: '../escape.ts' }, 'w3'),
      toolCall('read', { path: `${cwd}/src/c.ts` }, 'r1'),
    ].join('\n')
    expect(editedCheckoutFiles(text, cwd)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(editedCheckoutFiles(text, '/other/cwd')).toEqual([])
    expect(editedCheckoutFiles('not json', cwd)).toEqual([])
  })

  it('picks one branch, never guesses between several', () => {
    const base = { name: 'lane', prefix: 'phosphor/', hints: [] }
    expect(pickBranch({ ...base, available: ['main', 'agustin/lane'] })).toBe('agustin/lane')
    expect(pickBranch({ ...base, available: ['a/lane', 'b/lane'] })).toBeUndefined()
    expect(pickBranch({ ...base, available: ['a/lane', 'phosphor/lane'] })).toBe('phosphor/lane')
    expect(pickBranch({ ...base, available: ['a/lane', 'b/lane'], hints: ['b/lane'] })).toBe(
      'b/lane',
    )
    expect(pickBranch({ ...base, available: ['a/lane'], hints: ['gone'] })).toBe('a/lane')
    expect(pickBranch({ ...base, available: ['a/lanes', 'lane-2'] })).toBeUndefined()
  })
})

describe('recreating a removed checkout', () => recoveryCases(state))
