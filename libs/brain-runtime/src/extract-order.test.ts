import { writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { pipelineSetup, answerFor } from './__fixtures__/pipeline'
import { HARBOR_JOB } from './__fixtures__/fake-store'
import { extractJob } from './extract'
import type { StageExtraction } from './stage-types'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f()
})

async function ingest(order: string[]) {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  s.store.jobs = []
  const keys = new Map<string, string>(),
    proposals: unknown[] = []
  vi.spyOn(s.store, 'entityMatches').mockImplementation((probes) =>
    probes.map((p) =>
      p.keys.flatMap((k) =>
        keys.has(k.value)
          ? [{ entityId: keys.get(k.value)!, channel: 'key' as const, score: 1 }]
          : [],
      ),
    ),
  )
  s.runner.mockImplementation(async (input) => ({
    text: input.stage === 'extract' ? JSON.stringify(fixture(input.job.title)) : answerFor(input),
    usage: { tokens: 1, cost: 0 },
  }))
  for (const title of order) {
    const source = `Rina Okafor owns ${title}.`
    await writeFile(
      s.file,
      s.entries
        .map((e) =>
          JSON.stringify(
            e.type === 'session'
              ? { ...e, id: `lane-${title}` }
              : e.id === 'user'
                ? { ...e, message: { role: 'user', content: source } }
                : e,
          ),
        )
        .join('\n'),
    )
    const job = s.store.enqueue(
      { ...HARBOR_JOB, sessionId: `lane-${title}`, sessionPath: s.file, title },
      'queued',
    )
    await extractJob(job, new AbortController().signal, s.store, s.options, s.search)
    const p = s.store.storedProposal(job.id)!
    const label = (ref: string) =>
      p.entities.find((e) => e.ref === ref)?.label ?? s.store.cards.find((e) => e.id === ref)!.label
    proposals.push({
      lane: title,
      memories: p.memories.map((m) => ({
        text: m.summary,
        entities: m.entities.map(label).sort(),
        links: m.links.map((l) => [label(l.subject), l.predicate, label(l.object)]),
      })),
    })
    for (const e of p.entities) {
      const id = e.entityId ?? `saved-${s.store.cards.length}`
      if (!e.entityId)
        s.store.cards.push({
          id,
          label: e.label,
          kind: e.kind,
          description: e.description,
          aliases: e.aliases,
          neighbours: [],
          memories: 1,
        })
      for (const k of e.keys) keys.set(k.value, id)
    }
    s.store.review(
      job.id,
      { memories: p.memories.map((_m, i) => i), identities: {}, groups: [] },
      s.store.revision(),
    )
  }
  return proposals.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}
function fixture(title: string): StageExtraction {
  const quote = { segment: 's1', quote: `Rina Okafor owns ${title}.` }
  return {
    entities: [
      {
        ref: 'n1',
        label: 'Rina Okafor',
        kind: 'person',
        aliases: [],
        description: '',
        keys: [{ namespace: 'staff', value: 'rina-01' }],
      },
      {
        ref: 'n2',
        label: title,
        kind: 'project',
        aliases: [],
        description: '',
        keys: [{ namespace: 'project', value: title }],
      },
    ],
    claims: [
      {
        ref: 'c1',
        text: quote.quote,
        type: 'fact',
        epistemic: 'reported',
        mentions: ['n1', 'n2'],
        links: [{ subject: 'n1', predicate: 'owns', object: 'n2', ...quote }],
        quotes: [quote],
        branch: false,
        validFrom: null,
        validTo: null,
      },
    ],
    parents: [{ entity: 'n2', status: 'not_stated', claim: null }],
  }
}
it('reversed ingestion order of Harbor and Ledger produces the same supported proposals modulo ids', async () => {
  expect(await ingest(['Harbor', 'Ledger'])).toEqual(await ingest(['Ledger', 'Harbor']))
})
