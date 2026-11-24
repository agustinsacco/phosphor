import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fixture } from '@phosphor/memory-engine/test-support'
import { answerFor, pipelineSetup } from './__fixtures__/pipeline'
import { HARBOR_JOB } from './__fixtures__/fake-store'
import { RAW_EXTRACTION } from './__fixtures__/lane'
import type { ModelCallInput } from './model-call'
import { extractJob } from './extract'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
/** Reuses the first stored candidate of every identity the model is asked about. */
function reuseFirst(input: ModelCallInput): string {
  if (input.stage !== 'identity') return answerFor(input)
  const rows = JSON.parse(input.prompt.slice(input.prompt.indexOf('\n') + 1)) as {
    entity: { ref: string }
    candidates: unknown[]
  }[]
  return JSON.stringify({
    decisions: rows.map((row) => ({
      ref: row.entity.ref,
      action: row.candidates.length ? 'reuse' : 'new',
      candidate: row.candidates.length ? 'K1' : null,
      reason: 'Same fixture entity',
    })),
  })
}

/**
 * Brain holds "Rina Okafor owns Harbor billing." from the Harbor lane. A Kestrel planning lane says
 * the same thing later. Only a non-personal confirmation adds evidence.
 */
async function secondRead(hold: 'personal' | 'temporary' | null) {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  const { store } = fixture()
  const first = store.enqueue({ ...HARBOR_JOB, sessionPath: s.file }, 'queued')
  store.updateJob(first.id, { state: 'running' })
  await extractJob(first, new AbortController().signal, store, s.options, s.search)
  const rina = store.overview(300).nodes.find((node) => node.label === 'Rina Okafor')!.id
  const target = store.entityMemories(rina, {}, null).memories[0]!
  const before = store.memory(target.id)
  const file = join(s.directory, 'kestrel.jsonl')
  await writeFile(
    file,
    [
      { type: 'session', id: 'kestrel-lane', cwd: s.directory },
      { type: 'model_change', id: 'model', provider: 'example', modelId: 'fast' },
      {
        type: 'message',
        id: 'calibration',
        timestamp: '2026-11-13T09:00:00Z',
        message: { role: 'user', content: 'Rina Okafor owns Harbor billing.' },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  s.runner.mockImplementation(async (input: ModelCallInput) => ({
    text:
      input.stage === 'extract'
        ? JSON.stringify({
            ...RAW_EXTRACTION,
            claims: RAW_EXTRACTION.claims.map((claim) => ({ ...claim, hold })),
          })
        : reuseFirst(input),
    usage: { tokens: 1, cost: 0 },
  }))
  store.setPrefs({ ...store.snapshot().prefs, enabled: true })
  const second = store.enqueue(
    { ...HARBOR_JOB, sessionId: 'kestrel-lane', sessionPath: file, title: 'Kestrel planning' },
    'queued',
  )
  store.updateJob(second.id, { state: 'running' })
  await extractJob(second, new AbortController().signal, store, s.options, s.search)
  return { store, second, target: target.id, before }
}

it('a personal confirmation adds no evidence to the memory it repeats', async () => {
  const { store, second, target, before } = await secondRead('personal')
  expect(store.storedProposal(second.id)).toBeUndefined()
  expect(store.job(second.id)!.state).toBe('empty')
  expect(store.memory(target).quotes).toEqual(before.quotes)
  expect(store.memory(target).memory.observedAt).toBe(before.memory.observedAt)
})

it.each(['temporary', null] as const)(
  'a non-personal confirmation (%s) adds its evidence',
  async (hold) => {
    const { store, second, target, before } = await secondRead(hold)
    expect(store.job(second.id)!.state).toBe('done')
    expect(store.memory(target).quotes).toHaveLength(before.quotes.length + 1)
  },
)
