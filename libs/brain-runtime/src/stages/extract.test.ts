import { trackAsk } from '../__fixtures__/stage-ask'
import { expect, it } from 'vitest'
import { extractWindows } from './extract'
import { FakeBrainStore, HARBOR_JOB } from '../__fixtures__/fake-store'
import { makeWindow, transcriptWindows } from '../windows'
import type { StageAsk } from '../stage-types'
const empty = { entities: [], claims: [], parents: [] }
it('restart after window two resumes at window three under the same job id', async () => {
  const store = new FakeBrainStore(),
    job = store.enqueue(HARBOR_JOB, 'queued')
  const segments = Array.from({ length: 4 }, (_, i) => ({
    entryId: `e${i}`,
    role: 'user' as const,
    label: 'You',
    observedAt: 0,
    text: `part ${i}`,
  }))
  let count = 0
  const ask: StageAsk = async (_s, _p, _prompt, validate) => {
    if (++count === 3) throw new Error('Killed')
    return validate(JSON.stringify(empty))
  }
  const windows = segments.map((s) => makeWindow([s]))
  await expect(extractWindows(job.id, windows, store, ask, () => {}, segments)).rejects.toThrow(
    'Killed',
  )
  const resumed = trackAsk(async (_s, _p, _prompt, validate) => validate(JSON.stringify(empty)))
  const parts = await extractWindows(job.id, windows, store, resumed.ask, () => {}, segments)
  expect(parts).toHaveLength(4)
  expect(resumed.spy).toHaveBeenCalledTimes(2)
  expect(resumed.spy.mock.calls[0]![2]).toContain('part 2')
})
it('splits capped windows and accepts a capped single segment with an explicit flag', async () => {
  const store = new FakeBrainStore(),
    job = store.enqueue(HARBOR_JOB, 'queued')
  const segments = [0, 1].map((i) => ({
    entryId: `e${i}`,
    role: 'user' as const,
    label: 'You',
    observedAt: 0,
    text: 'Harbor',
  }))
  const capped = {
    ...empty,
    entities: Array.from({ length: 40 }, (_, i) => ({
      ref: `n${i + 1}`,
      label: `Concept ${i}`,
      kind: 'concept',
      aliases: [],
      description: '',
      keys: [],
    })),
  }
  const ask: StageAsk = async (_s, _p, _prompt, validate) => validate(JSON.stringify(capped))
  const parts = await extractWindows(
    job.id,
    transcriptWindows(segments),
    store,
    ask,
    () => {},
    segments,
  )
  expect(parts).toHaveLength(2)
  expect(parts.every((p) => p.truncated)).toBe(true)
})
it('a changed input hash never reuses a checkpoint', async () => {
  const store = new FakeBrainStore(),
    job = store.enqueue(HARBOR_JOB, 'queued'),
    ask = trackAsk(async (_s, _p, _prompt, validate) => validate(JSON.stringify(empty)))
  for (const text of ['Harbor', 'Ledger']) {
    const segments = [{ entryId: 'e', role: 'user' as const, label: 'You', observedAt: 0, text }]
    await extractWindows(job.id, transcriptWindows(segments), store, ask.ask, () => {}, segments)
  }
  expect(ask.spy).toHaveBeenCalledTimes(2)
})

it('prioritizes registry names mentioned in the current window over recent unrelated entities', async () => {
  const store = new FakeBrainStore(),
    job = store.enqueue(HARBOR_JOB, 'queued')
  const segments = ['many concepts', 'more concepts', 'Oldest concept matters'].map((text, i) => ({
    entryId: `e${i}`,
    role: 'user' as const,
    label: 'You',
    observedAt: 0,
    text,
  }))
  let call = 0
  const ask: StageAsk = async (_stage, _part, prompt, validate) => {
    call++
    if (call === 3) expect(prompt).toContain('"label":"Oldest concept"')
    const count = call === 1 ? 40 : call === 2 ? 30 : 0
    return validate(
      JSON.stringify({
        entities: Array.from({ length: count }, (_, i) => ({
          ref: `n${i + 1}`,
          label: call === 1 && i === 0 ? 'Oldest concept' : `Concept ${call}-${i}`,
          kind: 'concept',
          aliases: [],
          description: '',
          keys: [],
        })),
        claims: [],
        parents: [],
      }),
    )
  }
  await extractWindows(
    job.id,
    segments.map((s) => makeWindow([s])),
    store,
    ask,
    () => {},
    segments,
  )
})
