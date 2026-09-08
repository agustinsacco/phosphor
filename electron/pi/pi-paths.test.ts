import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claudeProjectDirName,
  claudeProjectsRoot,
  claudeSessionFileForCwd,
  clearRealCwdCache,
  piSessionsRoot,
  sessionDirForCwd,
  sessionDirNameForCwd,
} from './pi-paths'

/**
 * Both mangling rules are wire contracts with programs we do not control, and
 * both are load-bearing: get one wrong and we look for a session's ledger at a
 * path that cannot exist. The Claude Code cases below are transcribed from
 * real directories under ~/.claude/projects.
 */

describe('sessionDirNameForCwd (pi)', () => {
  it('joins segments with dashes and wraps in double dashes', () => {
    expect(sessionDirNameForCwd('/home/dev/proj')).toBe('--home-dev-proj--')
  })

  it('keeps dots, unlike the CLI', () => {
    expect(sessionDirNameForCwd('/home/dev/proj/.claude/worktrees/wt')).toBe(
      '--home-dev-proj-.claude-worktrees-wt--',
    )
  })
})

describe('claudeProjectDirName (Claude Code CLI)', () => {
  it('dashes every separator, with no wrapping', () => {
    expect(claudeProjectDirName('/home/dev/proj')).toBe('-home-dev-proj')
  })

  it('dashes dots too — which is where a separators-only rule breaks', () => {
    // The regression this guards: worktrees live under `.claude/`, so this is
    // the shape of nearly every session that has a CLI ledger at all.
    expect(claudeProjectDirName('/home/dev/proj/.claude/worktrees/wt')).toBe(
      '-home-dev-proj--claude-worktrees-wt',
    )
  })

  it('dashes every other non-alphanumeric, including underscores and colons', () => {
    expect(claudeProjectDirName('/home/dev/my_proj')).toBe('-home-dev-my-proj')
    expect(claudeProjectDirName('C:\\Users\\dev\\proj')).toBe('C--Users-dev-proj')
  })

  it('leaves a name of exactly the 200-character limit alone', () => {
    const cwd = '/' + 'a'.repeat(199)
    expect(claudeProjectDirName(cwd)).toHaveLength(200)
    expect(claudeProjectDirName(cwd)).toBe('-' + 'a'.repeat(199))
  })

  it('truncates past the limit and appends the CLI hash of the unmangled cwd', () => {
    // Verbatim from a real ~/.claude/projects directory: the source cwd
    // mangles to 201 characters, one over, so the CLI kept the first 200 and
    // appended `-81g7h6`. Reproducing that suffix is the whole point of the
    // hash — a prefix match alone would find the wrong project. The "pidex"
    // inside the path is deliberate: this sample predates the 2026-09-08
    // rename to Phosphor, and the hash is computed over the exact bytes, so
    // renaming the fixture would silently detach it from the real directory
    // it was captured from.
    const cwd =
      '/tmp/claude-1000/-home-agustinsacco-src-agustinsacco-pidex--claude-worktrees-pi-agent-cli-integration-b2e20a/aafae7b3-f013-473d-b384-bc1f3676c36b/scratchpad/matrix-thinking/claude-sonnet-5-websearch/ws'
    expect(claudeProjectDirName(cwd)).toBe(
      '-tmp-claude-1000--home-agustinsacco-src-agustinsacco-pidex--claude-worktrees-pi-agent-cli-integration-b2e20a-aafae7b3-f013-473d-b384-bc1f3676c36b-scratchpad-matrix-thinking-claude-sonnet-5-websearch-w-81g7h6',
    )
  })

  it('distinguishes two cwds that share a 200-character prefix', () => {
    const a = claudeProjectDirName('/' + 'a'.repeat(220) + '/one')
    const b = claudeProjectDirName('/' + 'a'.repeat(220) + '/two')
    expect(a.slice(0, 200)).toBe(b.slice(0, 200))
    expect(a).not.toBe(b)
  })
})

describe('claudeSessionFileForCwd', () => {
  const original = process.env.CLAUDE_CONFIG_DIR

  afterEach(() => {
    if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = original
  })

  it('names the file by the session id pi passes through to the CLI', () => {
    process.env.CLAUDE_CONFIG_DIR = '/cfg/claude'
    expect(claudeSessionFileForCwd('/home/dev/proj', 'sess-uuid-1')).toBe(
      join('/cfg/claude', 'projects', '-home-dev-proj', 'sess-uuid-1.jsonl'),
    )
  })

  it('honours the CLI\u2019s own CLAUDE_CONFIG_DIR override', () => {
    process.env.CLAUDE_CONFIG_DIR = '/elsewhere'
    expect(claudeProjectsRoot()).toBe(join('/elsewhere', 'projects'))
  })
})

/**
 * `realCwd` is a blocking syscall on the path of every session scan and every
 * session-dir watch, for a set of workspaces that does not change while the
 * app runs. These tests pin the memoization AND the one case that must never
 * be memoized.
 *
 * A symlink is what makes the behaviour observable on both CI platforms:
 * resolving changes the answer, so "did it resolve?" is readable from the
 * returned directory name alone, with no spying on node:fs.
 */
describe('realCwd memoization', () => {
  let root: string
  let target: string
  let link: string

  beforeEach(() => {
    clearRealCwdCache()
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'phosphor-realcwd-')))
    target = join(root, 'target')
    link = join(root, 'link')
    mkdirSync(target)
  })

  afterEach(() => {
    clearRealCwdCache()
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves once and answers from cache afterwards', () => {
    symlinkSync(target, link)
    const resolved = sessionDirForCwd(link)
    expect(resolved).toBe(join(piSessionsRoot(), sessionDirNameForCwd(target)))

    // With the link gone, only a cached answer can still be the resolved one.
    unlinkSync(link)
    expect(sessionDirForCwd(link)).toBe(resolved)

    // And clearing the cache must fall back to the unresolved path.
    clearRealCwdCache()
    expect(sessionDirForCwd(link)).toBe(join(piSessionsRoot(), sessionDirNameForCwd(link)))
  })

  it('does NOT cache a path that does not exist yet', () => {
    // A brand-new worktree is exactly this: something asks for its session
    // directory before the folder is there. Caching that miss would pin the
    // unresolved path for the life of the process.
    const unresolved = sessionDirForCwd(link)
    expect(unresolved).toBe(join(piSessionsRoot(), sessionDirNameForCwd(link)))

    symlinkSync(target, link)
    expect(sessionDirForCwd(link)).toBe(join(piSessionsRoot(), sessionDirNameForCwd(target)))
  })
})
