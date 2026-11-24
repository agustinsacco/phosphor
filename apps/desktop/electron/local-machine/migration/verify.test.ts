import { copyFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnerIndex } from '@phosphor/shared/host-protocol-owner'
import type { ArchiveRecord } from '@phosphor/session-runtime/lane-archive/storage'
import { MIGRATION_ID, SESSIONS, planFacts } from './__fixtures__/plan-facts'
import { IMPORT_STEPS, newJournal, withStep, type MigrationJournal } from './journal'
import { buildPlan, sectionHash, type MigrationPlan } from './plan'
import {
  TRANSCRIPT_READER_MAX_BYTES,
  fileVerifyPorts,
  spotMatches,
  verifyMigration,
  type FileIdentity,
  type VerifyInput,
  type VerifyPorts,
} from './verify'
import type { SessionWitness } from './witness'

const AT = '2026-11-23T10:00:00.000Z'
const AGENT = '/fixture/.pi/agent'
const WITNESS: SessionWitness = { version: 1, entries: [{ path: '/a', missing: true }] }

function stagedJournal(plan: MigrationPlan): MigrationJournal {
  let journal = newJournal({ migrationId: MIGRATION_ID, desktopVersion: '1.0.0', at: AT })
  for (const step of IMPORT_STEPS) {
    const section = plan.sections[step]
    if (section) journal = withStep(journal, step, 'done', AT, sectionHash(section))
  }
  return journal
}

function indexFor(plan: MigrationPlan): OwnerIndex {
  return {
    machineId: plan.machineId,
    agentDir: AGENT,
    sessionsRoot: SESSIONS,
    owning: false,
    migrateLevel: 1,
    lanes: plan.sections.lanes!.items.map((item) => ({
      laneId: item.laneId,
      sessionFile: item.sessionFile,
      sessionId: null,
      cwd: item.cwd,
      repositoryId: 'r',
    })),
  }
}

const archive = (over: Partial<ArchiveRecord> = {}): ArchiveRecord =>
  ({
    version: 1,
    id: 'f'.repeat(64),
    title: 'A',
    cwd: '/fixture/src/app',
    archivedAt: 1,
    state: 'archived',
    transcript: `${SESSIONS}/x/a.jsonl`,
    ...over,
  }) as ArchiveRecord

function setup() {
  const plan = buildPlan(planFacts())
  const input: VerifyInput = {
    plan,
    journal: stagedJournal(plan),
    index: indexFor(plan),
    witness: WITNESS,
    archives: [archive()],
    desktop: { agentDir: AGENT, sessionsRoot: SESSIONS },
    signal: new AbortController().signal,
  }
  const identity = (path: string): FileIdentity => ({
    real: path,
    dev: 1,
    ino: path.length,
    size: 10,
    isFile: true,
  })
  const ports: VerifyPorts = {
    readTranscript: vi.fn(async () => []),
    identity,
    hash: vi.fn(async () => 'h'),
    exists: () => true,
    liveRoutines: () => 1,
    copiedRoutines: () => 1,
    accounts: () => plan.expected.accounts,
    witnessNow: () => WITNESS,
  }
  return { plan, input, ports }
}

describe('verifyMigration', () => {
  it('passes a staged migration whose service index matches the plan', async () => {
    const { input, ports } = setup()
    expect(await verifyMigration(input, ports)).toEqual({ ok: true })
    expect(ports.hash).not.toHaveBeenCalled()
  })

  const lanes = (input: VerifyInput) => input.index.lanes
  const cases: [string, (s: ReturnType<typeof setup>) => void][] = [
    ['G1', ({ input }) => Object.assign(input.index, { lanes: lanes(input).slice(1) })],
    [
      'G1',
      ({ input }) => Object.assign(input.index, { lanes: [...lanes(input), lanes(input)[0]] }),
    ],
    [
      'G2',
      ({ input }) =>
        Object.assign(input.index, {
          lanes: lanes(input).map((r, i) => (i === 0 ? { ...r, cwd: '/elsewhere' } : r)),
        }),
    ],
    [
      'G3',
      ({ ports }) => Object.assign(ports, { readTranscript: () => Promise.reject(new Error()) }),
    ],
    [
      'G4',
      ({ input }) =>
        Object.assign(input, { journal: withStep(input.journal, 'marks', 'pending', AT) }),
    ],
    ['G5', ({ ports }) => Object.assign(ports, { liveRoutines: () => 2 })],
    ['G6', ({ ports }) => Object.assign(ports, { exists: () => false })],
    ['G6', ({ input }) => Object.assign(input, { archives: [] })],
    ['G7', ({ ports }) => Object.assign(ports, { accounts: () => 99 })],
    [
      'G8',
      ({ ports }) =>
        Object.assign(ports, {
          witnessNow: () => ({ version: 1, entries: [{ path: '/b', missing: true }] }),
        }),
    ],
    ['G8', ({ input }) => Object.assign(input, { witness: null })],
    [
      'G9',
      ({ input }) =>
        Object.assign(input, {
          journal: withStep(input.journal, 'policy', 'done', AT, '0'.repeat(64)),
        }),
    ],
    [
      'G10',
      ({ input }) => Object.assign(input.index, { sessionsRoot: '/other/.pi/agent/sessions' }),
    ],
    ['G11', ({ ports }) => Object.assign(ports, { deviceGate: () => false })],
  ]
  it.each(cases)('%s fails on one mutated input', async (gate, mutate) => {
    const s = setup()
    mutate(s)
    expect(await verifyMigration(s.input, s.ports)).toEqual({ ok: false, gate })
  })
})

describe('spotMatches (G3) on scratch files', () => {
  let root: string
  const signal = new AbortController().signal
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'm3-verify-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  const ports = (read = vi.fn(async () => [])) => ({
    ...setup().ports,
    ...fileVerifyPorts,
    readTranscript: read,
    hash: vi.fn(fileVerifyPorts.hash),
  })

  it('in place: the same file needs the reader and no hash', async () => {
    const file = join(root, 'a.jsonl')
    writeFileSync(file, '{"type":"session"}\n')
    const p = ports()
    expect(await spotMatches(p, file, file, signal)).toBe(true)
    expect(p.readTranscript).toHaveBeenCalledWith(file)
    expect(p.hash).not.toHaveBeenCalled()
  })

  it('copied: a different file must hold the same bytes', async () => {
    const a = join(root, 'a.jsonl')
    const b = join(root, 'b.jsonl')
    writeFileSync(a, '{"type":"session"}\n')
    copyFileSync(a, b)
    const p = ports()
    expect(await spotMatches(p, a, b, signal)).toBe(true)
    expect(p.hash).toHaveBeenCalledTimes(2)
    writeFileSync(b, '{"type":"session","x":1}\n')
    expect(await spotMatches(p, a, b, signal)).toBe(false)
  })

  it('over the reader cap: bytes only, the reader is never asked', async () => {
    const a = join(root, 'big.jsonl')
    const b = join(root, 'big-copy.jsonl')
    writeFileSync(a, '')
    truncateSync(a, TRANSCRIPT_READER_MAX_BYTES + 1)
    copyFileSync(a, b)
    const read = vi.fn(async () => {
      throw new Error('too large')
    })
    const p = ports(read)
    expect(await spotMatches(p, a, b, signal)).toBe(true)
    expect(read).not.toHaveBeenCalled()
    expect(await spotMatches(p, a, a, signal)).toBe(true)
  })

  it('refuses a missing or non-regular file and an aborted hash', async () => {
    const a = join(root, 'a.jsonl')
    writeFileSync(a, 'x\n')
    expect(await spotMatches(ports(), a, join(root, 'gone'), signal)).toBe(false)
    expect(await spotMatches(ports(), a, root, signal)).toBe(false)
    const b = join(root, 'b.jsonl')
    copyFileSync(a, b)
    const aborted = AbortSignal.abort()
    await expect(spotMatches(ports(), a, b, aborted)).rejects.toThrow()
  })
})
