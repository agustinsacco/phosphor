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
 * the same thing later, and the model holds it as personal. Review is off for that second read.
 */
async function secondRead(hold: 'personal' | null) {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  const { store } = fixture()
  const first = store.enqueue({ ...HARBOR_JOB, sessionPath: s.file }, 'queued')
  await extractJob(first, new AbortController().signal, store, s.options, s.search)
  store.review(
    first.id,
    { memories: [0], identities: {}, groups: [], descriptions: [], confirmations: [] },
    store.proposal(first.id).revision,
  )
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
  store.setPrefs({ ...store.snapshot().prefs, enabled: true, review: false })
  const second = store.enqueue(
    { ...HARBOR_JOB, sessionId: 'kestrel-lane', sessionPath: file, title: 'Kestrel planning' },
    'queued',
  )
  await extractJob(second, new AbortController().signal, store, s.options, s.search)
  return { store, second, target: target.id, before }
}

it('with review off, a held confirmation adds no evidence to the memory it repeats', async () => {
  const { store, second, target, before } = await secondRead('personal')
  expect(store.storedProposal(second.id)).toBeUndefined()
  expect(store.job(second.id)!.state).toBe('done')
  expect(store.memory(target).quotes).toEqual(before.quotes)
  expect(store.memory(target).memory.observedAt).toBe(before.memory.observedAt)
})

it('with review off, a confirmation that is not held still adds its evidence', async () => {
  const { store, second, target, before } = await secondRead(null)
  expect(store.job(second.id)!.state).toBe('done')
  expect(store.memory(target).quotes).toHaveLength(before.quotes.length + 1)
})
