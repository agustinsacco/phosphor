import { describe, expect, it } from 'vitest'
import { isWorktreeFolder as rendererIsWorktreeFolder } from '../../client-ui/src/lib/path'
import { isWorktreeFolder, WORKTREE_SEGMENT } from '@phosphor/shared/worktree-segment'

describe('worktree-segment', () => {
  it('exports the exact non-stateful historical segment expression', () => {
    expect(WORKTREE_SEGMENT.source).toBe(/[/\\]\.(?:phosphor|pidex)[/\\]worktrees[/\\]/.source)
    expect(WORKTREE_SEGMENT.flags).toBe('')
  })

  it('accepts both names with every combination of separators', () => {
    for (const name of ['phosphor', 'pidex']) {
      for (const before of ['/', '\\']) {
        for (const middle of ['/', '\\']) {
          for (const after of ['/', '\\']) {
            const path = `repo${before}.${name}${middle}worktrees${after}task`
            expect(rendererIsWorktreeFolder(path)).toBe(true)
            expect(isWorktreeFolder(path)).toBe(true)
            expect(WORKTREE_SEGMENT.test(path)).toBe(true)
          }
        }
      }
    }
  })

  it.each([
    ['/.phosphor/worktrees/task', true],
    ['\\.pidex\\worktrees\\task', true],
    ['repo/.phosphor/worktrees/task', true],
    ['./.pidex/worktrees/task', true],
    ['/repo/.phosphor/worktrees/', true],
    ['/repo/.pidex/worktrees\\', true],
    ['/repo/.phosphor/worktrees/../elsewhere', true],
    ['/repo/.phosphor/worktrees/task/.pidex/worktrees/nested', true],
    ['', false],
    ['/', false],
    ['.phosphor/worktrees/task', false],
    ['.pidex\\worktrees\\task', false],
    ['/repo/.phosphor/worktrees', false],
    ['/repo/.pidex/worktrees', false],
    ['/repo/.PHOSPHOR/worktrees/task', false],
    ['/repo/.PIDEX/worktrees/task', false],
    ['/repo/.phosphor/Worktrees/task', false],
    ['/repo/.phosphor/worktrees2/task', false],
    ['/repo/.phosphor2/worktrees/task', false],
    ['/repo/x.phosphor/worktrees/task', false],
    ['/repo/phosphor/worktrees/task', false],
    ['/repo/.phosphor//worktrees/task', false],
    ['/repo/.claude/worktrees/task', false],
    ['/repo/.pi/agent/sessions/task', false],
  ] as const)('classifies %j as %s without normalization', (path, expected) => {
    expect(rendererIsWorktreeFolder(path)).toBe(expected)
    expect(isWorktreeFolder(path)).toBe(expected)
    expect(WORKTREE_SEGMENT.test(path)).toBe(expected)
  })

  it('keeps the exported expression and predicate stable across repeated calls', () => {
    for (let call = 0; call < 3; call++) {
      expect(isWorktreeFolder('/repo/.phosphor/worktrees/task')).toBe(true)
      expect(WORKTREE_SEGMENT.test('/repo/.phosphor/worktrees/task')).toBe(true)
      expect(isWorktreeFolder('/repo')).toBe(false)
      expect(WORKTREE_SEGMENT.test('/repo')).toBe(false)
      expect(WORKTREE_SEGMENT.lastIndex).toBe(0)
    }
  })
})
