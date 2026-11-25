import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

function lane(name: string, transcript: string | null, model?: { provider: string; id: string }) {
  const sessionFile = join(sessions, `${name}.jsonl`)
  if (transcript !== null) writeFileSync(sessionFile, transcript)
  return store.ensureLane({
    repositoryId: store.listRepositories()[0]!.id,
    cwd: repository,
    sessionFile,
    updatedAt: '2025-03-04T10:00:00.000Z',
    ...(model ? { provider: model.provider, model: model.id } : {}),
  })
}

describe('repairLaneModels', () => {
  it('fills an imported lane’s missing model from its transcript, keeping its recency', () => {
    const imported = lane('imported', piTranscript(CLAUDE_LANE))
    expect(imported.model).toBeNull()
    expect(repairLaneModels(store, sessions)).toEqual({ repaired: 1, skipped: 0, unreadable: 0 })
    expect(store.getLane(imported.laneId)).toMatchObject({
      model: { provider: 'pi-claude-cli', id: 'claude-opus-5' },
      updatedAt: '2025-03-04T10:00:00.000Z',
    })
  })

  it('leaves a recorded model alone and is a no-op the second time', () => {
    const recorded = lane('recorded', piTranscript(CLAUDE_LANE), { provider: 'openai', id: 'o5' })
    lane('imported', piTranscript(CLAUDE_LANE))
    expect(repairLaneModels(store, sessions).repaired).toBe(1)
    expect(store.getLane(recorded.laneId)?.model).toEqual({ provider: 'openai', id: 'o5' })
    expect(repairLaneModels(store, sessions)).toEqual({ repaired: 0, skipped: 0, unreadable: 0 })
  })

  it('counts a lane with no model to read and a transcript it cannot read', () => {
    const silent = lane('silent', piTranscript([userMessage('u1', 'hi')]))
    const gone = lane('gone', null)
    expect(repairLaneModels(store, sessions)).toEqual({ repaired: 0, skipped: 1, unreadable: 1 })
    expect(store.getLane(silent.laneId)?.model).toBeNull()
    expect(store.getLane(gone.laneId)?.model).toBeNull()
  })

  it('stops reading at its byte budget and leaves the rest for the next start', () => {
    lane('first', piTranscript(CLAUDE_LANE))
    lane('second', piTranscript(CLAUDE_LANE))
    expect(repairLaneModels(store, sessions, { budgetBytes: 1 })).toEqual({
      repaired: 0,
      skipped: 2,
      unreadable: 0,
    })
    expect(repairLaneModels(store, sessions).repaired).toBe(2)
  })
})
