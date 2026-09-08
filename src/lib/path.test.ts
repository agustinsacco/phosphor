import { describe, it, expect } from 'vitest'
import {
  basename,
  dirname,
  isWorktreeFolder,
  projectName,
  projectPathFor,
  splitPath,
  workspaceName,
  worktreeAwareName,
} from './path'

describe('isWorktreeFolder', () => {
  it('flags a path inside a repo worktree folder', () => {
    expect(isWorktreeFolder('/home/u/phosphor/.phosphor/worktrees/some-task')).toBe(true)
    expect(isWorktreeFolder('C:\\Users\\u\\Phosphor\\.phosphor\\worktrees\\task')).toBe(true)
    // Lanes created before the 2026-09-08 rename still live under `.pidex`.
    expect(isWorktreeFolder('/home/u/phosphor/.pidex/worktrees/some-task')).toBe(true)
  })

  it('does not flag the main repo, another workspace, or a session dir', () => {
    expect(isWorktreeFolder('/home/u/phosphor')).toBe(false)
    expect(isWorktreeFolder('/home/u/games')).toBe(false)
    expect(isWorktreeFolder('/home/u/.pi/agent/sessions/--x--')).toBe(false)
  })

  it('requires the folder component, not just the substring', () => {
    expect(isWorktreeFolder('/home/u/phosphor/.phosphor/worktrees2/x')).toBe(false)
    expect(isWorktreeFolder('/home/u/phosphorworktrees/x')).toBe(false)
  })
})

// Existing suite below
describe('basename', () => {
  it.each([
    ['src/lib/a.ts', 'a.ts'],
    ['a.ts', 'a.ts'],
    ['C:\\Users\\a\\b.ts', 'b.ts'],
    ['/abs/path/c.ts', 'c.ts'],
  ])('reduces %s to %s', (input, expected) => {
    expect(basename(input)).toBe(expected)
  })

  it('falls back to the whole path when it ends in a separator', () => {
    expect(basename('src/lib/')).toBe('src/lib/')
  })

  it('returns an empty string unchanged', () => {
    expect(basename('')).toBe('')
  })
})

describe('dirname', () => {
  it.each([
    ['src/lib/a.ts', 'src/lib'],
    ['/abs/a.ts', '/abs'],
    ['C:\\Users\\a.ts', 'C:\\Users'],
  ])('reduces %s to %s', (input, expected) => {
    expect(dirname(input)).toBe(expected)
  })

  it('returns an empty string when there is no directory part', () => {
    expect(dirname('a.ts')).toBe('')
  })

  it('handles a root-level file', () => {
    expect(dirname('/a.ts')).toBe('')
  })

  it('uses the last separator when both kinds are present', () => {
    expect(dirname('C:\\Users/mixed/a.ts')).toBe('C:\\Users/mixed')
  })
})

describe('splitPath', () => {
  it('splits directory and basename together', () => {
    expect(splitPath('src/lib/a.ts')).toEqual({ dir: 'src/lib', base: 'a.ts' })
  })

  it('yields an empty dir for a bare filename', () => {
    expect(splitPath('a.ts')).toEqual({ dir: '', base: 'a.ts' })
  })
})

describe('workspaceName', () => {
  it.each([
    ['/home/u/proj', 'proj'],
    ['/home/u/proj/', 'proj'],
    ['/home/u/proj///', 'proj'],
    ['C:\\Users\\u\\proj', 'proj'],
  ])('names %s as %s', (input, expected) => {
    expect(workspaceName(input)).toBe(expected)
  })

  it('falls back to the input when there are no real segments', () => {
    expect(workspaceName('/')).toBe('/')
  })
})

describe('projectPathFor', () => {
  it('returns the path itself outside a worktree', () => {
    expect(projectPathFor('/Users/u/phosphor')).toBe('/Users/u/phosphor')
    expect(projectPathFor('/Users/u/phosphor', { isWorktree: false })).toBe('/Users/u/phosphor')
  })

  it('prefers git mainRepoPath, which covers a worktree anywhere on disk', () => {
    expect(
      projectPathFor('/tmp/detached-checkout', {
        isWorktree: true,
        mainRepoPath: '/Users/u/phosphor',
      }),
    ).toBe('/Users/u/phosphor')
  })

  it('falls back to the path shape when git info has not loaded', () => {
    // The reported bug: every surface renders once before `git:infoBatch`
    // answers, and one whose cwd never gets an answer renders that way for
    // good. Without this branch the top bar sat on the branch slug.
    expect(projectPathFor('/Users/u/phosphor/.phosphor/worktrees/hey-2')).toBe('/Users/u/phosphor')
    expect(projectPathFor('C:\\Users\\u\\Phosphor\\.phosphor\\worktrees\\hey-2')).toBe(
      'C:\\Users\\u\\Phosphor',
    )
    // Lanes created before the 2026-09-08 rename still live under `.pidex`.
    expect(projectPathFor('/Users/u/phosphor/.pidex/worktrees/hey-2')).toBe('/Users/u/phosphor')
  })

  it('still resolves the repo when git reports isWorktree false', () => {
    // Stale or partial git info must not resurrect the folder basename: the
    // path shape alone proves this is a worktree Phosphor made.
    expect(
      projectPathFor('/Users/u/phosphor/.phosphor/worktrees/main', {
        isWorktree: false,
        mainRepoPath: '/Users/u/phosphor',
      }),
    ).toBe('/Users/u/phosphor')
  })

  it('uses a known root for a worktree the path shape cannot recognise', () => {
    // The startup bug: worktrees living outside `<repo>/.phosphor/worktrees/`
    // each opened their own sidebar group, named after their branch, until
    // `git:infoBatch` answered. `git worktree list` already reported the repo
    // they belong to, so no round trip is needed.
    expect(projectPathFor('/tmp/pr15889-wt', undefined, '/Users/u/services')).toBe(
      '/Users/u/services',
    )
    expect(
      projectPathFor(
        '/Users/u/services/.claude/worktrees/blissful',
        undefined,
        '/Users/u/services',
      ),
    ).toBe('/Users/u/services')
    expect(projectPathFor('/Users/u/services-know719', undefined, '/Users/u/services')).toBe(
      '/Users/u/services',
    )
  })

  it('still prefers git info over a known root', () => {
    // The root comes from whichever repo we happened to list; git's own
    // answer is authoritative for the folder itself.
    expect(
      projectPathFor('/tmp/wt', { isWorktree: true, mainRepoPath: '/Users/u/a' }, '/Users/u/b'),
    ).toBe('/Users/u/a')
  })

  it('cuts at the outermost worktree folder', () => {
    expect(projectPathFor('/Users/u/phosphor/.phosphor/worktrees/a/.phosphor/worktrees/b')).toBe(
      '/Users/u/phosphor',
    )
  })
})

describe('projectName', () => {
  it('names the repo, never the worktree folder or its branch', () => {
    // A worktree folder is named after its branch, so its basename read as if
    // the user had switched projects. The branch has its own control.
    expect(projectName('/Users/u/phosphor/.phosphor/worktrees/hey-2')).toBe('phosphor')
    expect(
      projectName('/Users/u/phosphor/.phosphor/worktrees/hey-2', {
        isWorktree: true,
        mainRepoPath: '/Users/u/phosphor',
      }),
    ).toBe('phosphor')
  })

  it('is the folder basename for an ordinary workspace', () => {
    expect(projectName('/Users/u/games')).toBe('games')
  })
})

describe('worktreeAwareName', () => {
  // The window title only. It is one line with nowhere else to put the
  // branch; every in-app surface sits under a top bar that names the folder
  // and the branch separately, and uses `projectName`.
  it('appends the branch for a linked worktree', () => {
    expect(
      worktreeAwareName('/Users/u/phosphor/.phosphor/worktrees/main', {
        isWorktree: true,
        mainRepoPath: '/Users/u/phosphor',
        branch: 'main',
      }),
    ).toBe('phosphor (main)')
  })

  it('is just the project when the branch is unknown', () => {
    expect(
      worktreeAwareName('/Users/u/phosphor/.phosphor/worktrees/main', {
        isWorktree: true,
        mainRepoPath: '/Users/u/phosphor',
      }),
    ).toBe('phosphor')
  })

  it('names the project, not the folder, before git info arrives', () => {
    // It delegates to `projectName`, so it inherits the path-shape fallback:
    // this used to read "main" for the Phosphor repo.
    expect(worktreeAwareName('/Users/u/phosphor/.phosphor/worktrees/main')).toBe('phosphor')
  })

  it('is the folder basename for an ordinary workspace', () => {
    expect(worktreeAwareName('/Users/u/games')).toBe('games')
  })
})
