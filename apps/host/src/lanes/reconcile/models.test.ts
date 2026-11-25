import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLAUDE_LANE, piTranscript, userMessage } from '../__fixtures__/pi-transcript'
import { openStore, type HostStore } from '../store'
import { repairLaneModels } from './models'

let root: string
let sessions: string
let repository: string
let store: HostStore
const uid = process.getuid?.()

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'host-model-repair-')))
  sessions = join(root, 'sessions')
  repository = join(root, 'repository')
  for (const dir of [sessions, repository]) mkdirSync(dir)
  store = await openStore(join(root, 'state'), uid, {
    now: () => Date.parse('2025-01-01T00:00:00.000Z'),
  })
  store.syncRepositories([repository])
})
afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

function lane(
  name: string,
  transcript: string | null,
  model?: { provider: string; id: string },
  updatedAt = '2025-03-04T10:00:00.000Z',
) {
  const sessionFile = join(sessions, `${name}.jsonl`)
  if (transcript !== null) writeFileSync(sessionFile, transcript)
  return store.ensureLane({
    repositoryId: store.listRepositories()[0]!.id,
    cwd: repository,
    sessionFile,
    updatedAt,
    ...(model ? { provider: model.provider, model: model.id } : {}),
  })
}

/** A transcript with no model in it, longer than `bytes`. */
const silentTranscript = (bytes: number) => piTranscript([userMessage('u1', 'x'.repeat(bytes))])
const counts = (repaired: number, skipped: number, unreadable: number, unchanged = 0) => ({
  repaired,
  skipped,
  unreadable,
  unchanged,
})

describe('repairLaneModels', () => {
  it('fills an imported lane’s missing model from its transcript, keeping its recency', () => {
    const imported = lane('imported', piTranscript(CLAUDE_LANE))
    expect(imported.model).toBeNull()
    expect(repairLaneModels(store, sessions).counts).toEqual(counts(1, 0, 0))
    expect(store.getLane(imported.laneId)).toMatchObject({
      model: { provider: 'pi-claude-cli', id: 'claude-opus-5' },
      updatedAt: '2025-03-04T10:00:00.000Z',
    })
  })

  it('leaves a recorded model alone and is a no-op the second time', () => {
    const recorded = lane('recorded', piTranscript(CLAUDE_LANE), { provider: 'openai', id: 'o5' })
    lane('imported', piTranscript(CLAUDE_LANE))
    expect(repairLaneModels(store, sessions).counts.repaired).toBe(1)
    expect(store.getLane(recorded.laneId)?.model).toEqual({ provider: 'openai', id: 'o5' })
    expect(repairLaneModels(store, sessions).counts).toEqual(counts(0, 0, 0))
  })

  it('counts a lane with no model to read and a transcript it cannot read', () => {
    const silent = lane('silent', piTranscript([userMessage('u1', 'hi')]))
    const gone = lane('gone', null)
    expect(repairLaneModels(store, sessions).counts).toEqual(counts(0, 1, 1))
    expect(store.getLane(silent.laneId)?.model).toBeNull()
    expect(store.getLane(gone.laneId)?.model).toBeNull()
  })

  it('stops reading at its byte budget and leaves the rest for the next start', () => {
    lane('first', piTranscript(CLAUDE_LANE))
    lane('second', piTranscript(CLAUDE_LANE))
    expect(repairLaneModels(store, sessions, { budgetBytes: 1 }).counts).toEqual(counts(0, 2, 0))
    expect(repairLaneModels(store, sessions).counts.repaired).toBe(2)
  })

  it('reads the most recently active lanes first', () => {
    const older = lane('older', piTranscript(CLAUDE_LANE), undefined, '2025-03-01T10:00:00.000Z')
    const newer = lane('newer', piTranscript(CLAUDE_LANE), undefined, '2025-03-09T10:00:00.000Z')
    const budgetBytes = Buffer.byteLength(piTranscript(CLAUDE_LANE))
    expect(repairLaneModels(store, sessions, { budgetBytes }).counts).toEqual(counts(1, 1, 0))
    expect(store.getLane(newer.laneId)?.model).not.toBeNull()
    expect(store.getLane(older.laneId)?.model).toBeNull()
  })

  it('remembers a lane read without a result, and reads it again only once its file changes', () => {
    const silent = lane('silent', silentTranscript(10))
    const first = repairLaneModels(store, sessions)
    expect(first.counts).toEqual(counts(0, 1, 0))
    expect([...first.scanned.keys()]).toEqual([silent.laneId])
    expect(first.scanned.get(silent.laneId)).toMatch(/^none:\d+:/)

    const again = repairLaneModels(store, sessions, { scanned: first.scanned })
    expect(again.counts).toEqual(counts(0, 0, 0, 1))
    expect(again.scanned).toEqual(first.scanned)

    writeFileSync(silent.sessionFile!, piTranscript(CLAUDE_LANE))
    utimesSync(silent.sessionFile!, new Date(), new Date(Date.now() + 5000))
    const changed = repairLaneModels(store, sessions, { scanned: again.scanned })
    expect(changed.counts).toEqual(counts(1, 0, 0))
    expect(changed.scanned.size).toBe(0)
  })

  it('makes progress across starts: a lane past the budget gets its turn', () => {
    const tailBytes = 1024
    const options = { tailBytes, budgetBytes: tailBytes }
    lane('a', silentTranscript(2 * tailBytes), undefined, '2025-03-09T10:00:00.000Z')
    lane('b', silentTranscript(2 * tailBytes), undefined, '2025-03-08T10:00:00.000Z')
    const last = lane('c', piTranscript(CLAUDE_LANE), undefined, '2025-03-01T10:00:00.000Z')
    let scanned: ReadonlyMap<string, string> = new Map()
    const starts: number[] = []
    for (let start = 0; start < 3; start++) {
      const run = repairLaneModels(store, sessions, { ...options, scanned })
      scanned = run.scanned
      starts.push(run.counts.repaired)
    }
    expect(starts).toEqual([0, 0, 1])
    expect(store.getLane(last.laneId)?.model).toEqual({
      provider: 'pi-claude-cli',
      id: 'claude-opus-5',
    })
  })

  it('remembers a lane whose tail ends before its model as capped, apart from none', () => {
    const far = lane('far', silentTranscript(4096))
    const first = repairLaneModels(store, sessions, { tailBytes: 1024 })
    expect(first.counts).toEqual(counts(0, 1, 0))
    expect(first.scanned.get(far.laneId)).toMatch(/^capped:\d+:/)
    const again = repairLaneModels(store, sessions, { tailBytes: 1024, scanned: first.scanned })
    expect(again.counts).toEqual(counts(0, 0, 0, 1))
    expect(store.getLane(far.laneId)?.model).toBeNull()
  })

  it('does not remember a lane the budget cut short', () => {
    lane('cut', silentTranscript(4096))
    const run = repairLaneModels(store, sessions, { tailBytes: 2048, budgetBytes: 1024 })
    expect(run.counts).toEqual(counts(0, 1, 0))
    expect(run.scanned.size).toBe(0)
  })
})
