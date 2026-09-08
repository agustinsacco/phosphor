import { describe, expect, it } from 'vitest'
import { branchNameFor, normalizePrefix, slugifyTitle } from './branchName'

describe('slugifyTitle', () => {
  it('kebab-cases a generated session title', () => {
    expect(slugifyTitle('Composer Autogrow Fix')).toBe('composer-autogrow-fix')
  })

  it('strips punctuation, accents and repeated separators', () => {
    expect(slugifyTitle('Café: fix the "user\'s" login — again!!')).toBe(
      'cafe-fix-the-user-s-login-again',
    )
  })

  it('never produces a ref git would reject', () => {
    // Every one of these is a name `git check-ref-format` refuses: leading
    // dash, `..`, `@{`, control characters, a `.lock` suffix.
    for (const hostile of ['-x', '..', 'a..b', 'a@{0}', 'x.lock', 'a b\tc', '~^:?*[\\']) {
      const slug = slugifyTitle(hostile)
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/)
      expect(slug).not.toContain('..')
      expect(slug.endsWith('.lock')).toBe(false)
    }
  })

  it('falls back rather than returning an empty slug', () => {
    expect(slugifyTitle('')).toBe('session')
    expect(slugifyTitle('   ')).toBe('session')
    expect(slugifyTitle('!!! ???')).toBe('session')
  })

  it('truncates long titles on a word boundary', () => {
    const slug = slugifyTitle(
      'Investigate why the sidebar session grouping collapses after a rename',
    )
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug.endsWith('-')).toBe(false)
    // Cut between words, so no severed fragment at the end.
    expect(slug).toBe('investigate-why-the-sidebar-session')
  })

  it('hard-truncates a single long word rather than emptying it', () => {
    const slug = slugifyTitle('a'.repeat(80))
    expect(slug).toBe('a'.repeat(40))
  })
})

describe('normalizePrefix', () => {
  it('keeps a prefix that already ends in a separator', () => {
    expect(normalizePrefix('phosphor/')).toBe('phosphor/')
    expect(normalizePrefix('phosphor-')).toBe('phosphor-')
    expect(normalizePrefix('wip_')).toBe('wip_')
  })

  it('adds a slash to a bare prefix, since that is what "Phosphor" means', () => {
    expect(normalizePrefix('phosphor')).toBe('phosphor/')
    expect(normalizePrefix('  agus/session  ')).toBe('agus/session/')
  })

  it('treats an empty or unusable prefix as no prefix', () => {
    expect(normalizePrefix('')).toBe('')
    expect(normalizePrefix('   ')).toBe('')
    expect(normalizePrefix('///')).toBe('')
  })

  it('strips characters that would make an invalid ref', () => {
    expect(normalizePrefix('phos phor?/')).toBe('phosphor/')
    expect(normalizePrefix('../escape/')).toBe('escape/')
    expect(normalizePrefix('a//b')).toBe('a/b/')
  })
})

describe('branchNameFor', () => {
  const base = { prefix: 'phosphor/', takenBranches: [], takenFolders: [] }

  it('pairs a folder with its prefixed branch', () => {
    expect(branchNameFor({ ...base, title: 'Session Naming And Worktrees' })).toEqual({
      folder: 'session-naming-and-worktrees',
      branch: 'phosphor/session-naming-and-worktrees',
    })
  })

  it('omits the prefix when none is configured', () => {
    expect(branchNameFor({ ...base, prefix: '', title: 'Quick Fix' })).toEqual({
      folder: 'quick-fix',
      branch: 'quick-fix',
    })
  })

  it('suffixes past a taken branch', () => {
    expect(
      branchNameFor({ ...base, title: 'Quick Fix', takenBranches: ['phosphor/quick-fix'] }),
    ).toEqual({ folder: 'quick-fix-2', branch: 'phosphor/quick-fix-2' })
  })

  it('suffixes past a taken folder even when the branch is free', () => {
    // The worktree was removed with `git branch -d` succeeding, or the folder
    // survived a prune: either half being taken must move the pair along.
    expect(branchNameFor({ ...base, title: 'Quick Fix', takenFolders: ['quick-fix'] })).toEqual({
      folder: 'quick-fix-2',
      branch: 'phosphor/quick-fix-2',
    })
  })

  it('keeps counting past a run of collisions', () => {
    expect(
      branchNameFor({
        ...base,
        title: 'Quick Fix',
        takenBranches: ['phosphor/quick-fix', 'phosphor/quick-fix-2'],
        takenFolders: ['quick-fix-3'],
      }),
    ).toEqual({ folder: 'quick-fix-4', branch: 'phosphor/quick-fix-4' })
  })

  it('compares case-insensitively, because the folder lands on a case-insensitive disk', () => {
    expect(branchNameFor({ ...base, title: 'Quick Fix', takenFolders: ['Quick-Fix'] })).toEqual({
      folder: 'quick-fix-2',
      branch: 'phosphor/quick-fix-2',
    })
  })
})

describe('configurable slug length', () => {
  it('honours a shorter cap', () => {
    const slug = slugifyTitle('fix the composer autogrow jump on paste', 16)
    expect(slug.length).toBeLessThanOrEqual(16)
  })

  it('still cuts on a word boundary at a custom cap', () => {
    expect(slugifyTitle('fix the composer autogrow jump', 20)).not.toMatch(/-$/)
    expect(slugifyTitle('fix the composer autogrow jump', 20)).toBe('fix-the-composer')
  })

  it('threads the cap through branchNameFor', () => {
    const { folder, branch } = branchNameFor({
      title: 'fix the composer autogrow jump on paste',
      prefix: 'phosphor/',
      takenBranches: [],
      takenFolders: [],
      maxSlug: 16,
    })
    expect(folder.length).toBeLessThanOrEqual(16)
    expect(branch).toBe(`phosphor/${folder}`)
  })

  it('refuses an absurdly small cap rather than producing an empty slug', () => {
    expect(slugifyTitle('composer autogrow', 1).length).toBeGreaterThan(0)
  })
})
