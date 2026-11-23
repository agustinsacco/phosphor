import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  JOURNAL_FILE,
  journalWriter,
  migrationPermit,
  newJournal,
  parseJournal,
  pastCommitPoint,
  readJournal,
  stepDone,
  withState,
  withStep,
} from './journal'

const ID = '00000000-0000-4000-8000-000000000001'
const AT = '2026-11-23T10:00:00.000Z'
let dir: string
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'm3-journal-')), 'daemon-migration')
})
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }))

const allowed = migrationPermit({ isPackaged: true, env: {} })

describe('migrationPermit', () => {
  it('allows a packaged app', () => {
    expect(allowed.allowed).toBe(true)
  })

  it('allows an unpackaged build only with PHOSPHOR_MIGRATE=1 and PHOSPHOR_TEST_USER_DATA', () => {
    const permit = (env: NodeJS.ProcessEnv) => migrationPermit({ isPackaged: false, env }).allowed
    expect(permit({})).toBe(false)
    expect(permit({ PHOSPHOR_MIGRATE: '1' })).toBe(false)
    expect(permit({ PHOSPHOR_TEST_USER_DATA: '/tmp/x' })).toBe(false)
    expect(permit({ PHOSPHOR_MIGRATE: 'true', PHOSPHOR_TEST_USER_DATA: '/tmp/x' })).toBe(false)
    expect(permit({ PHOSPHOR_MIGRATE: '1', PHOSPHOR_TEST_USER_DATA: '/tmp/x' })).toBe(true)
  })

  it('refuses a writer without a permit and writes nothing', () => {
    const denied = migrationPermit({ isPackaged: false, env: {} })
    expect(() => journalWriter(dir, denied)).toThrow(/PHOSPHOR_MIGRATE=1/)
    expect(() => statSync(dir)).toThrow()
  })
})

describe('the journal file', () => {
  it('round-trips through a private file and reads none when absent', () => {
    expect(readJournal(dir)).toEqual({ kind: 'none' })
    const journal = withStep(
      newJournal({ migrationId: ID, desktopVersion: '1.2.3', at: AT }),
      'backup',
      'done',
      AT,
      'a'.repeat(64),
    )
    journalWriter(dir, allowed).write(journal)
    expect(readJournal(dir)).toEqual({ kind: 'ok', journal })
    expect(statSync(join(dir, JOURNAL_FILE)).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(readdirSync(dir)).toEqual([JOURNAL_FILE])
  })

  it('reads a damaged or foreign file as unreadable, never as none', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, JOURNAL_FILE), '{"version":1,')
    expect(readJournal(dir)).toEqual({ kind: 'unreadable' })
    writeFileSync(join(dir, JOURNAL_FILE), JSON.stringify({ version: 2 }))
    expect(readJournal(dir)).toEqual({ kind: 'unreadable' })
  })

  it('refuses unknown states, steps and failure codes that could carry a path', () => {
    const base = newJournal({ migrationId: ID, desktopVersion: '1', at: AT })
    const text = (over: object) => JSON.stringify({ ...base, ...over })
    expect(parseJournal(text({}))).toEqual(base)
    expect(parseJournal(text({ state: 'daemon-pending' }))).toBeNull()
    expect(parseJournal(text({ steps: [{ step: 'teleport', status: 'done', at: AT }] }))).toBeNull()
    expect(parseJournal(text({ failure: { step: 'plan', code: '/Users/me/secret' } }))).toBeNull()
    expect(parseJournal(text({ failure: { step: 'plan', code: 'limits' } }))?.failure).toEqual({
      step: 'plan',
      code: 'limits',
    })
  })

  it('keeps one entry per step, in step order, and replaces a pending one', () => {
    let journal = newJournal({ migrationId: ID, desktopVersion: '1', at: AT })
    journal = withStep(journal, 'plan', 'pending', AT)
    journal = withStep(journal, 'backup', 'done', AT)
    journal = withStep(journal, 'plan', 'done', AT, 'b'.repeat(64))
    expect(journal.steps.map((s) => [s.step, s.status])).toEqual([
      ['backup', 'done'],
      ['plan', 'done'],
    ])
    expect(stepDone(journal, 'plan', 'b'.repeat(64))).toBe(true)
    expect(stepDone(journal, 'plan', 'c'.repeat(64))).toBe(false)
    expect(stepDone(journal, 'begin')).toBe(false)
  })

  it('records a failure with a state and clears it on the next state', () => {
    const base = newJournal({ migrationId: ID, desktopVersion: '1', at: AT })
    const aborted = withState(base, 'aborted', AT, { step: 'verify', code: 'g8' })
    expect(aborted.failure).toEqual({ step: 'verify', code: 'g8' })
    expect(withState(aborted, 'running', AT).failure).toBeUndefined()
  })

  it('writes atomically: the file always holds a whole journal', () => {
    const writer = journalWriter(dir, allowed)
    for (let i = 0; i < 20; i++) {
      writer.write(newJournal({ migrationId: ID, desktopVersion: String(i), at: AT }))
      expect(parseJournal(readFileSync(join(dir, JOURNAL_FILE), 'utf8'))?.desktopVersion).toBe(
        String(i),
      )
    }
    expect(readdirSync(dir)).toEqual([JOURNAL_FILE])
  })

  it('names the commit point: from commit-requested on, never in-app', () => {
    expect(pastCommitPoint('running')).toBe(false)
    expect(pastCommitPoint('aborted')).toBe(false)
    expect(pastCommitPoint('commit-requested')).toBe(true)
    expect(pastCommitPoint('committed')).toBe(true)
  })
})
