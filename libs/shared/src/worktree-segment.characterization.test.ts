import { describe, expect, it } from 'vitest'
import { isWorktreeFolder } from '../../client-ui/src/lib/path'
import { isWorktreeFolder as isStoredWorktreeFolder } from '../../../apps/desktop/electron/prefs/workspaces'

describe('internal worktree segment characterization', () => {
  it.each([
    ['/repo/.phosphor/worktrees/task', true],
    ['C:\\repo\\.phosphor\\worktrees\\task', true],
    ['C:\\repo/.phosphor\\worktrees/task', true],
    ['/repo/.pidex/worktrees/task', true],
    ['C:\\repo\\.pidex\\worktrees\\task', true],
    ['/repo/.pidex\\worktrees/task', true],
    ['/.phosphor/worktrees/task', true],
    ['repo/.phosphor/worktrees/task', true],
    ['/repo/.phosphor/worktrees/', true],
    ['/repo/.phosphor/worktrees/task/.pidex/worktrees/nested', true],
    ['', false],
    ['/repo', false],
    ['/repo/.pi/agent/sessions/task', false],
    ['.phosphor/worktrees/task', false],
    ['/repo/.phosphor/worktrees', false],
    ['/repo/.phosphor/worktrees2/task', false],
    ['/repo/.phosphor2/worktrees/task', false],
    ['/repo/phosphor/worktrees/task', false],
    ['/repo/x.phosphor/worktrees/task', false],
    ['/repo/.Phosphor/worktrees/task', false],
    ['/repo/.phosphor/Worktrees/task', false],
    ['/repo/.PIDEX/worktrees/task', false],
  ] as const)('classifies %j as %s in renderer and prefs', (path, expected) => {
    expect(isWorktreeFolder(path)).toBe(expected)
    expect(isStoredWorktreeFolder(path)).toBe(expected)
  })

  it('keeps repeated and interleaved calls stable', () => {
    for (let call = 0; call < 3; call++) {
      for (const classify of [isWorktreeFolder, isStoredWorktreeFolder]) {
        expect(classify('/repo/.phosphor/worktrees/task')).toBe(true)
        expect(classify('/repo')).toBe(false)
        expect(classify('/repo/.pidex/worktrees/task')).toBe(true)
      }
    }
  })
})
