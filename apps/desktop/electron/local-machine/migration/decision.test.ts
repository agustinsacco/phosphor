import { describe, expect, it } from 'vitest'
import { MIGRATION_ID } from './__fixtures__/plan-facts'
import { MAX_ATTEMPTS, decideLaunch, type LaunchFacts } from './decision'
import {
  POST_COMMIT_STEPS,
  newJournal,
  withState,
  withStep,
  type JournalState,
  type MigrationJournal,
} from './journal'

const AT = '2026-11-23T10:00:00.000Z'

function journal(state: JournalState, over: Partial<MigrationJournal> = {}): MigrationJournal {
  return {
    ...withState(
      newJournal({ migrationId: MIGRATION_ID, desktopVersion: '2.0.0', at: AT }),
      state,
      AT,
    ),
    ...over,
  }
}

function finished(): MigrationJournal {
  let j = journal('committed')
  for (const step of [...POST_COMMIT_STEPS, 'done'] as const) j = withStep(j, step, 'done', AT)
  return j
}

/** A packaged Mac with Desktop's own standby service installed and in-app data. */
const facts = (over: Partial<LaunchFacts> = {}): LaunchFacts => ({
  permitted: true,
  journal: { kind: 'none' },
  lock: 'free',
  recorded: true,
  legacyKeys: true,
  localRuntime: false,
  reachable: true,
  packaged: true,
  e2eDaemon: false,
  attempts: 0,
  ...over,
})
const ok = (j: MigrationJournal) => ({ kind: 'ok' as const, journal: j })

describe('decideLaunch: every row', () => {
  it('a default real launch (no service recorded) stays in-app and migrates nothing', () => {
    expect(decideLaunch(facts({ recorded: false }))).toEqual({
      kind: 'in-app',
      status: { mode: 'in-app', migration: 'not-needed' },
    })
  })

  it('an unpackaged run without both flags stays in-app, whatever is installed', () => {
    expect(decideLaunch(facts({ permitted: false, packaged: false })).kind).toBe('in-app')
  })

  it('no journal, free lock, recorded service: migrate', () => {
    expect(decideLaunch(facts())).toEqual({ kind: 'migrate', previous: null })
  })

  it('aborted: migrate again under the attempt limit, then stop with the failure', () => {
    const aborted = journal('aborted', { failure: { step: 'verify', code: 'gate-g1' } })
    expect(decideLaunch(facts({ journal: ok(aborted), attempts: 2 }))).toEqual({
      kind: 'migrate',
      previous: aborted,
    })
    expect(decideLaunch(facts({ journal: ok(aborted), attempts: MAX_ATTEMPTS }))).toEqual({
      kind: 'in-app',
      status: { mode: 'in-app', migration: 'failed', failure: aborted.failure },
    })
    const retry = { ...aborted, retryRequested: true as const }
    expect(decideLaunch(facts({ journal: ok(retry), attempts: MAX_ATTEMPTS })).kind).toBe('migrate')
  })

  it('running (a crash before commit-requested): abort it and migrate', () => {
    const running = journal('running')
    expect(decideLaunch(facts({ journal: ok(running) }))).toEqual({
      kind: 'migrate',
      previous: running,
    })
  })

  it('commit-requested never starts in-app: resume through the service, even when unpermitted', () => {
    const requested = journal('commit-requested')
    expect(decideLaunch(facts({ journal: ok(requested) }))).toEqual({
      kind: 'resume',
      journal: requested,
    })
    for (const over of [
      { permitted: false },
      { recorded: false },
      { lock: 'daemon' as const },
      { e2eDaemon: true },
    ])
      expect(decideLaunch(facts({ journal: ok(requested), ...over })).kind).toBe('resume')
  })

  it('committed and finished: daemon mode; unfinished: replay; unreachable dev build: its notice', () => {
    expect(decideLaunch(facts({ journal: ok(finished()) }))).toEqual({
      kind: 'daemon',
      status: { mode: 'daemon', migration: 'committed' },
    })
    expect(decideLaunch(facts({ journal: ok(journal('committed')) })).kind).toBe('resume')
    expect(
      decideLaunch(
        facts({ journal: ok(finished()), reachable: false, packaged: false, permitted: false }),
      ),
    ).toEqual({
      kind: 'daemon',
      status: { mode: 'daemon', migration: 'committed', service: 'down', notice: 'dev-build' },
    })
  })

  it('reverted: in-app until Retry', () => {
    expect(decideLaunch(facts({ journal: ok(journal('reverted')) }))).toEqual({
      kind: 'in-app',
      status: { mode: 'in-app', migration: 'reverted' },
    })
    const retried = journal('reverted', { retryRequested: true })
    expect(decideLaunch(facts({ journal: ok(retried) })).kind).toBe('migrate')
  })

  it('N12: a live service holds the lock and in-app data exists: consent-needed, in-app', () => {
    const plan = {
      kind: 'in-app',
      status: { mode: 'in-app', migration: 'consent-needed', notice: 'other-daemon' },
    }
    expect(decideLaunch(facts({ lock: 'daemon', recorded: false }))).toEqual(plan)
    expect(decideLaunch(facts({ lock: 'daemon', journal: ok(journal('consented')) }))).toEqual(plan)
  })

  it('a live service with no in-app data: daemon mode when it is Desktop’s, else in-app', () => {
    expect(decideLaunch(facts({ lock: 'daemon', legacyKeys: false })).kind).toBe('daemon')
    expect(
      decideLaunch(
        facts({ lock: 'daemon', legacyKeys: false, recorded: false, localRuntime: true }),
      ).kind,
    ).toBe('daemon')
    expect(decideLaunch(facts({ lock: 'daemon', legacyKeys: false, recorded: false }))).toEqual({
      kind: 'in-app',
      status: { mode: 'in-app', migration: 'not-needed', notice: 'other-daemon' },
    })
  })

  it('E1’s gated e2e hook without the migrate flag: daemon mode directly', () => {
    expect(
      decideLaunch(facts({ e2eDaemon: true, permitted: false, packaged: false, recorded: false })),
    ).toEqual({ kind: 'daemon', status: { mode: 'daemon', migration: 'not-needed' } })
  })

  it('an unreadable journal is never "none"', () => {
    const unreadable = { kind: 'unreadable' as const }
    expect(decideLaunch(facts({ journal: unreadable })).kind).toBe('daemon')
    expect(decideLaunch(facts({ journal: unreadable, recorded: false }))).toMatchObject({
      kind: 'in-app',
      status: { migration: 'failed', failure: { code: 'journal-unreadable' } },
    })
  })
})
