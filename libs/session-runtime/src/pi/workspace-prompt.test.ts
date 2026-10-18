import { describe, expect, it } from 'vitest'
import { worktreePromptBlock } from './workspace-prompt'

const CWD = '/home/u/src/phosphor/.phosphor/worktrees/read-composer'
const MAIN = '/home/u/src/phosphor'

describe('worktreePromptBlock', () => {
  it('names the cwd and the main checkout for a worktree session', () => {
    const block = worktreePromptBlock(CWD, {
      isRepo: true,
      isWorktree: true,
      mainRepoPath: MAIN,
    })
    expect(block).toContain(`Working directory: ${CWD}`)
    expect(block).toContain(MAIN)
    expect(block).toContain('DIFFERENT branch')
  })

  it('adds nothing for an ordinary repo — pi already states the cwd', () => {
    expect(worktreePromptBlock(MAIN, { isRepo: true, isWorktree: false })).toBeUndefined()
  })

  it('adds nothing outside a repo', () => {
    expect(worktreePromptBlock('/tmp/scratch', { isRepo: false })).toBeUndefined()
  })

  it('adds nothing when git reported a worktree without a main checkout', () => {
    expect(worktreePromptBlock(CWD, { isRepo: true, isWorktree: true })).toBeUndefined()
  })

  it('adds nothing when the main checkout is the cwd itself', () => {
    expect(
      worktreePromptBlock(MAIN, { isRepo: true, isWorktree: true, mainRepoPath: MAIN }),
    ).toBeUndefined()
  })
})
