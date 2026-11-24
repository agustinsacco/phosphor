import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBrainCuratorClient } from '@phosphor/brain-client/curator-client'
import { createNodeBrainTransport } from '@phosphor/brain-client/node-transport'
import type { BrainStore, Proposal } from '@phosphor/memory-engine/types'
import type { BrainService, BrainServiceOptions } from '../types'
import { realService } from '../tidy/__fixtures__/real-service'

const CURATOR = { extension: '/made-up/brain-curator.mjs', skill: '/made-up/brain-agent' }
const reason = 'These Harbor facts have evidence in the lane.'
/** The bridge's frame limit, which no single curator answer may need. */
const FRAME = 512 * 1024
/** A call's answer, or `{ refused }` with its error, so either is checked by assertion. */
const answer = <T>(call: Promise<T>) =>
  call.catch((error: unknown) => ({ refused: error instanceof Error ? error.message : error }))
const sentence = (seed: string, length: number) =>
  `${seed} `.padEnd(length, 'Kestrel settles Harbor invoices weekly with Ledger. ')

/** The Harbor planning lane, queued to be read. */
async function queueLongRead(store: BrainStore, options: BrainServiceOptions) {
  const sessionPath = join(options.directory, 'harbor-long.jsonl')
  await writeFile(
    sessionPath,
    [
      { type: 'session', id: 'harbor-long', cwd: '/Harbor' },
      { type: 'session_info', name: 'Harbor planning' },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  return store.enqueue(
    {
      sessionId: 'harbor-long',
      sessionPath,
      title: 'Harbor planning',
      scope: '/Harbor',
      branch: null,
      model: 'example/reader',
      leafId: 'leaf-1',
    },
    'queued',
  )
}

/**
 * A read as long as the extractor makes them: 300 memories (CLAIM_BUDGET), each quoted twice,
 * each quote's excerpt 400 characters either side of it. `required` adds an identity question
 * Brain cannot answer alone, named by the last `required` memories.
 */
async function proposeLongRead(store: BrainStore, options: BrainServiceOptions, required = 0) {
  const job = await queueLongRead(store, options)
  const labels = Array.from({ length: Math.max(1, required) }, (_, i) =>
    i === 0 ? 'Rina Okafor' : `Tom Lee ${i}`,
  )
  const entities: Proposal['entities'] = labels.map((label, i) => ({
    ref: `r${i}`,
    label,
    kind: 'person',
    aliases: [],
    description: 'Ledger lead',
    keys: [],
    decision: required ? 'uncertain' : 'new',
    entityId: null,
    candidates: [],
    reason: '',
    auto: false,
    required: required > 0,
  }))
  const summaries = Array.from({ length: 300 }, (_, i) => sentence(`Harbor fact ${i}.`, 300))
  const quotes = summaries.map((_, i) => [
    sentence(`Quote ${i}a.`, 300),
    sentence(`Quote ${i}b.`, 300),
  ])
  const embed = async (texts: string[]) =>
    (await options.embeddings.embed(texts, 'document')).map((v) => new Float32Array(v))
  store.propose({
    jobId: job.id,
    origin: { sessionId: job.sessionId, title: job.title },
    scope: job.scope,
    branch: null,
    computedRevision: store.knowledgeRevision(),
    entities,
    memoryVectors: await embed(summaries),
    entityVectors: await embed(labels),
    groups: [],
    confirmations: [],
    held: 0,
    memories: summaries.map((summary, i) => ({
      summary,
      kind: 'reported',
      type: 'fact',
      entities: [i >= 300 - required ? `r${300 - 1 - i}` : 'r0'],
      links: [],
      branch: false,
      validFrom: null,
      validTo: null,
      action: 'add',
      target: null,
      reason: '',
      citations: quotes[i]!.map((quote, n) => ({ evidence: 2 * i + n, quote })),
    })),
    evidence: quotes.flat().map((quote, n) => ({
      sessionId: job.sessionId,
      entryId: `entry-${n}`,
      role: 'user',
      label: 'Harbor planning',
      observedAt: n + 1,
      text: `${'Before the quote. '.repeat(23).slice(0, 400)}${quote}${' After the quote.'.repeat(24).slice(0, 400)}`,
    })),
  })
  return store.job(job.id)!
}

async function curatorClient(service: BrainService) {
  const launch = (await service.curatorLaunch())!
  const connection = launch.connection
  const transport = createNodeBrainTransport(connection, { timeoutMs: 60_000 })
  return { client: createBrainCuratorClient(transport), transport }
}

describe('a long read over the bridge', { timeout: 120_000 }, () => {
  it('opens every page and approves by default, though the whole read exceeds a frame', async () => {
    const { store, service, options } = await realService({ curator: CURATOR })
    const job = await proposeLongRead(store, options)
    expect(JSON.stringify(store.proposal(job.id)).length).toBeGreaterThan(FRAME)
    const { client } = await curatorClient(service)
    const seen: number[] = []
    let offset: number | undefined
    for (let page = 0; page < 100; page++) {
      const request = offset === undefined ? { jobId: job.id } : { jobId: job.id, offset }
      const opened = await answer(client.call('readReview', request))
      expect(opened).toMatchObject({ text: expect.stringContaining('Harbor planning') })
      const { text } = opened as { text: string }
      expect(text.length).toBeLessThanOrEqual(8000)
      seen.push(...[...text.matchAll(/^- (\d+) · fact/gm)].map((match) => Number(match[1])))
      const next = /Call again with offset (\d+)\./.exec(text)
      if (!next) {
        expect(text).toContain('That is the end of this read.')
        break
      }
      offset = Number(next[1])
    }
    expect(seen).toEqual(Array.from({ length: 300 }, (_, i) => i))
    const revision = store.proposal(job.id).revision
    await expect(
      client.call('decideRead', { jobId: job.id, revision, approve: true, reason }),
    ).resolves.toMatchObject({ status: 'done', operationId: expect.any(String) })
    expect(store.laneMemories('harbor-long').ids).toHaveLength(300)
  })

  it('says a page past the end is the end, and refuses an offset that is not one', async () => {
    const { store, service, options } = await realService({ curator: CURATOR })
    const job = await proposeLongRead(store, options)
    const { client, transport } = await curatorClient(service)
    const past = await answer(client.call('readReview', { jobId: job.id, offset: 10_000 }))
    expect(past).toMatchObject({ text: expect.stringContaining('That is the end of this read.') })
    expect((past as { text: string }).text).not.toMatch(/^- \d+ · fact/m)
    const refusal = 'Brain review offset must be a whole number, 0 or more.'
    for (const offset of [-1, 1.5, '3'])
      await expect(
        client.call('readReview', { jobId: job.id, offset: offset as number }),
      ).rejects.toThrow(refusal)
    // The bridge checks it too, for a caller that skips the client.
    await expect(
      transport.request('readReview', { jobId: job.id, offset: -1 }, AbortSignal.timeout(30_000)),
    ).rejects.toThrow(refusal)
  })

  it('refuses approval that would save a memory naming an unanswered required identity', async () => {
    const { store, service, options } = await realService({ curator: CURATOR })
    const job = await proposeLongRead(store, options, 12)
    const { client } = await curatorClient(service)
    const revision = store.proposal(job.id).revision
    const refused = await answer(
      client.call('decideRead', { jobId: job.id, revision, approve: true, reason }),
    )
    expect(refused).toMatchObject({ status: 'refused', operationId: null })
    const result = refused as { message: string }
    expect(result.message.length).toBeLessThanOrEqual(400)
    expect(result.message).toContain('r0, r1, r2')
    expect(result.message).toMatch(/ and \d+ more/)
    expect(result.message).toContain('brain_read_review')
    expect(store.job(job.id)?.state).toBe('review')
    expect(store.laneMemories('harbor-long').ids).toEqual([])
    // Answered, the same approval saves.
    const identities = Array.from({ length: 12 }, (_, i) => ({ ref: `r${i}`, answer: 'new' }))
    await expect(
      client.call('decideRead', { jobId: job.id, revision, approve: true, identities, reason }),
    ).resolves.toMatchObject({ status: 'done' })
  })

  it('saves nothing when the read was refreshed since Brain Agent opened it', async () => {
    const { store, service, options } = await realService({ curator: CURATOR })
    const job = await proposeLongRead(store, options)
    const { client } = await curatorClient(service)
    const revision = store.proposal(job.id).revision
    await expect(
      client.call('decideRead', { jobId: job.id, revision: revision + 1, approve: true, reason }),
    ).resolves.toMatchObject({ status: 'changed' })
    expect(store.job(job.id)?.state).toBe('review')
    expect(store.laneMemories('harbor-long').ids).toEqual([])
  })
})
