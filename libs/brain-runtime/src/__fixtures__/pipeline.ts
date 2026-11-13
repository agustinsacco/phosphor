import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { ModelCallInput } from '../model-call'
import { FakeBrainStore, FakeBrainSearch, HARBOR_JOB } from './fake-store'
import { recallOptions } from './options'
import { LANE_ENTRIES, RAW_EXTRACTION } from './lane'

export function answerFor(input: ModelCallInput): string {
  if (input.stage === 'extract' || input.stage === 'repair') return JSON.stringify(RAW_EXTRACTION)
  if (input.stage === 'parents') {
    const requested = JSON.parse(input.prompt.match(/Requested:(.*)\n/)![1]!) as { ref: string }[]
    return JSON.stringify({
      entities: [],
      claims: [],
      parents: requested.map((e) => ({ entity: e.ref, status: 'not_stated', claim: null })),
    })
  }
  if (input.stage === 'identity') {
    const rows = JSON.parse(input.prompt.slice(input.prompt.indexOf('\n') + 1)) as {
      entity: { ref: string }
    }[]
    return JSON.stringify({
      decisions: rows.map((r) => ({
        ref: r.entity.ref,
        action: 'new',
        candidate: null,
        reason: 'Distinct fixture entity',
      })),
    })
  }
  const rows = JSON.parse(input.prompt.slice(input.prompt.indexOf('\n') + 1)) as {
    claim: { ref: string }
  }[]
  return JSON.stringify({
    decisions: rows.map((r) => ({
      ref: r.claim.ref,
      action: 'add',
      target: null,
      reason: 'Different assertion',
    })),
  })
}
export async function pipelineSetup() {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-pipeline-'))
  const file = join(directory, 'harbor.jsonl')
  const entries = LANE_ENTRIES.map((e) => (e.type === 'session' ? { ...e, cwd: directory } : e))
  await writeFile(file, entries.map((e) => JSON.stringify(e)).join('\n'))
  const store = new FakeBrainStore(),
    search = new FakeBrainSearch()
  store.prefs.enabled = true
  const runner = vi.fn(async (input: ModelCallInput) => ({
    text: answerFor(input),
    usage: { tokens: 10, cost: 0 },
  }))
  const options = {
    ...recallOptions(store),
    directory,
    openSearch: () => search,
    runModelCall: runner,
    log: vi.fn(),
    onChange: vi.fn(),
  }
  const job = store.enqueue({ ...HARBOR_JOB, sessionPath: file }, 'queued')
  return {
    directory,
    file,
    entries,
    store,
    search,
    runner,
    options,
    job,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}
