import { describe, expect, it } from 'vitest'
import { contains, isMainCheckoutPath } from './main-checkout'

/** The real shape: Phosphor puts worktrees inside the checkout they branch from. */
const MAIN = '/home/u/src/phosphor'
const CWD = `${MAIN}/.phosphor/worktrees/read-composer`
const WORKTREE = { cwd: CWD, mainRepoPath: MAIN }

describe('contains', () => {
  it('matches the directory itself and its descendants, never a sibling with the same prefix', () => {
    expect(contains(MAIN, MAIN)).toBe(true)
    expect(contains(MAIN, `${MAIN}/CLAUDE.md`)).toBe(true)
    expect(contains(MAIN, `${MAIN}-old/CLAUDE.md`)).toBe(false)
    expect(contains(`${MAIN}/`, `${MAIN}/CLAUDE.md`)).toBe(true)
  })
})

describe('isMainCheckoutPath', () => {
  it('names the main checkout’s files and nothing in the worktree, even though one contains the other', () => {
    expect(isMainCheckoutPath(`${MAIN}/CLAUDE.md`, WORKTREE)).toBe(true)
    expect(isMainCheckoutPath(`${MAIN}/docs/AGENTS.md`, WORKTREE)).toBe(true)
    expect(isMainCheckoutPath(`${CWD}/CLAUDE.md`, WORKTREE)).toBe(false)
    expect(isMainCheckoutPath(`${CWD}/libs/AGENTS.md`, WORKTREE)).toBe(false)
  })

  it('leaves rules inherited from above the repository, and anything unrelated, alone', () => {
    expect(isMainCheckoutPath('/home/u/src/AGENTS.md', WORKTREE)).toBe(false)
    expect(isMainCheckoutPath('/home/u/.pi/agent/AGENTS.md', WORKTREE)).toBe(false)
    expect(isMainCheckoutPath(`${MAIN}-old/CLAUDE.md`, WORKTREE)).toBe(false)
  })

  it('resolves a relative path against the worktree, so it is never the main checkout’s', () => {
    expect(isMainCheckoutPath('CLAUDE.md', WORKTREE)).toBe(false)
    expect(isMainCheckoutPath('../../../CLAUDE.md', WORKTREE)).toBe(true)
  })

  it('is false outside a worktree', () => {
    expect(isMainCheckoutPath(`${MAIN}/CLAUDE.md`, null)).toBe(false)
    expect(isMainCheckoutPath(`${MAIN}/CLAUDE.md`, undefined)).toBe(false)
  })
})
