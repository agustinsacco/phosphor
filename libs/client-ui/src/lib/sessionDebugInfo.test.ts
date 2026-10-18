import { describe, it, expect } from 'vitest'
import {
  claudeProjectDirName,
  claudeSessionPath,
  formatSessionDebugInfo,
  piSessionDirName,
  type SessionDebugSource,
} from './sessionDebugInfo'

const source: SessionDebugSource = {
  path: '/home/dev/.pi/agent/sessions/--home-dev-proj--/2026-08-22T22-56-30-785Z_01a02bb0.jsonl',
  sessionId: '01a02bb0-a041-7109-9d1c-8333ecea33c4',
  cwd: '/home/dev/proj',
  provider: 'pi-claude-cli',
  model: 'claude-opus-5',
}

describe('directory mangling', () => {
  it('wraps pi session dirs in double dashes', () => {
    expect(piSessionDirName('/home/dev/proj')).toBe('--home-dev-proj--')
  })

  it('leaves the Claude project dir unwrapped', () => {
    // The two harnesses mangle differently; conflating them sends the reader
    // to a path that does not exist.
    expect(claudeProjectDirName('/home/dev/proj')).toBe('-home-dev-proj')
    expect(claudeProjectDirName('/home/dev/proj')).not.toBe(piSessionDirName('/home/dev/proj'))
  })

  it('dashes dots for the CLI but keeps them for pi', () => {
    // Worktrees live under `.claude/`, so this is the common shape, not an
    // edge case — the CLI turns the dot into a dash and pi does not.
    expect(claudeProjectDirName('/home/dev/proj/.claude/worktrees/wt')).toBe(
      '-home-dev-proj--claude-worktrees-wt',
    )
    expect(piSessionDirName('/home/dev/proj/.claude/worktrees/wt')).toBe(
      '--home-dev-proj-.claude-worktrees-wt--',
    )
  })

  it('handles windows separators', () => {
    // pi dashes the drive colon too: `C:` → `C-`, then the separator → `C--`.
    expect(piSessionDirName('C:\\Users\\dev\\proj')).toBe('--C--Users-dev-proj--')
    expect(claudeProjectDirName('C:\\Users\\dev\\proj')).toBe('C--Users-dev-proj')
  })
})

describe('claudeSessionPath', () => {
  it('points at the CLI copy for Claude Code sessions', () => {
    expect(claudeSessionPath(source)).toBe(
      '~/.claude/projects/-home-dev-proj/01a02bb0-a041-7109-9d1c-8333ecea33c4.jsonl',
    )
  })

  it('returns null for other providers, rather than a path that cannot exist', () => {
    expect(claudeSessionPath({ ...source, provider: 'anthropic' })).toBeNull()
    expect(claudeSessionPath({ ...source, provider: undefined })).toBeNull()
  })

  it('files the copy under the CLI’s own session id when there is one', () => {
    // Observer mode: pi's id and the CLI's id are different, and the CLI's is
    // the one the transcript is named after. Building the path from the pi id
    // printed a file that has never existed.
    expect(
      claudeSessionPath({ ...source, claudeSessionId: 'dea87c8e-4de1-4f0e-9d5b-9a3c2f10c0b7' }),
    ).toBe('~/.claude/projects/-home-dev-proj/dea87c8e-4de1-4f0e-9d5b-9a3c2f10c0b7.jsonl')
  })

  it('falls back to the pi id when the provider recorded no mapping', () => {
    // Sessions from before observer mode, where the two really were one id.
    expect(claudeSessionPath({ ...source, claudeSessionId: null })).toBe(
      '~/.claude/projects/-home-dev-proj/01a02bb0-a041-7109-9d1c-8333ecea33c4.jsonl',
    )
  })
})

describe('formatSessionDebugInfo', () => {
  it('includes both ledgers for a Claude Code session', () => {
    const out = formatSessionDebugInfo(source)
    expect(out).toContain('id:       01a02bb0-a041-7109-9d1c-8333ecea33c4')
    expect(out).toContain('cwd:      /home/dev/proj')
    expect(out).toContain(source.path)
    expect(out).toContain('provider: pi-claude-cli / claude-opus-5')
    expect(out).toContain('~/.claude/projects/-home-dev-proj/')
  })

  it('omits the claude line for other providers', () => {
    const out = formatSessionDebugInfo({ ...source, provider: 'anthropic', model: 'x' })
    expect(out).not.toContain('claude:')
    expect(out).toContain('provider: anthropic / x')
  })

  it('omits the provider line entirely when unknown', () => {
    const out = formatSessionDebugInfo({ ...source, provider: undefined, model: undefined })
    expect(out).not.toContain('provider:')
    expect(out).not.toContain('claude:')
    // The pi pointers must survive regardless — they are the part that always exists.
    expect(out).toContain('id:')
    expect(out).toContain('file:')
  })

  it('stays plain text, one field per line', () => {
    const lines = formatSessionDebugInfo(source).split('\n')
    expect(lines[0]).toBe('pi session')
    expect(lines.slice(1).every((l) => l.startsWith('  '))).toBe(true)
  })
})
