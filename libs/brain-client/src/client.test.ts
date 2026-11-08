import type { BrainEvidence, BrainSearchResult } from '@phosphor/shared/brain'
import { describe, expect, it, vi } from 'vitest'
import { BrainClientError, createBrainClient } from './client'
import type { BrainTransport } from './port'

const EVIDENCE: BrainEvidence = {
  id: 'ev1',
  scope: 'scope-a',
  sessionId: 's1',
  entryId: 'n1',
  parentId: null,
  rootIds: ['ev1'],
  branch: null,
  role: 'user',
  label: 'lane one',
  observedAt: 1,
  text: 'Ana owns billing',
  hash: 'h',
}

const SEARCH: BrainSearchResult = {
  graphRevision: 3,
  policyEpoch: 1,
  status: 'ok',
  results: [
    {
      claim: {
        id: 'c1',
        scope: 'scope-a',
        subjectId: 'ana',
        predicate: 'owns',
        objectId: 'billing',
        literal: null,
        summary: 'Ana owns billing',
        kind: 'reported',
        state: 'active',
        citations: [{ evidenceId: 'ev1', quote: 'Ana owns billing' }],
        conflictIds: [],
        validFrom: null,
        validTo: null,
        recordedAt: 2,
        retractedAt: null,
        revision: 1,
      },
      evidence: [EVIDENCE],
      reasons: ['exact'],
      score: 1,
    },
  ],
  entities: [{ id: 'ana', scope: 'scope-a', label: 'Ana', kind: 'person', aliases: [] }],
  degradation: [],
  truncated: false,
}

function transportReturning(data: unknown) {
  const request = vi.fn<BrainTransport['request']>().mockResolvedValue(data as never)
  return { transport: { request } as BrainTransport, request }
}

describe('createBrainClient', () => {
  it('maps each typed call to its agent method and params', async () => {
    const { transport, request } = transportReturning(SEARCH)
    const client = createBrainClient(transport)
    const signal = new AbortController().signal
    await client.search({ query: 'billing', limit: 3 }, signal)
    await client.brief('who owns billing')
    expect(request.mock.calls).toEqual([
      ['search', { query: 'billing', limit: 3 }, signal],
      ['brief', { query: 'who owns billing' }, undefined],
    ])
  })

  it('wraps read, job and propose params without caller-supplied scope', async () => {
    const read = transportReturning(EVIDENCE)
    await createBrainClient(read.transport).read('ev1')
    expect(read.request).toHaveBeenCalledWith('read', { evidenceId: 'ev1' }, undefined)

    const job = transportReturning({
      job: {
        id: 'j1',
        scope: 'scope-a',
        state: 'running',
        fence: 2,
        evidenceIds: ['ev1'],
        graphRevision: 3,
        policyEpoch: 1,
      },
      evidence: [EVIDENCE],
    })
    await createBrainClient(job.transport).job()
    expect(job.request).toHaveBeenCalledWith('job', {}, undefined)

    const propose = transportReturning({ proposalId: 'p1' })
    const input = { entities: [], claims: [], rationale: 'none' }
    await expect(createBrainClient(propose.transport).propose(input)).resolves.toEqual({
      proposalId: 'p1',
    })
    expect(propose.request).toHaveBeenCalledWith('propose', { input }, undefined)
  })

  it.each([
    ['search', null],
    ['search', { ...SEARCH, status: 'great' }],
    ['search', { ...SEARCH, results: [{ claim: {}, evidence: [], reasons: [], score: 1 }] }],
    ['search', { ...SEARCH, graphRevision: '3' }],
    ['read', { ...EVIDENCE, text: 7 }],
    ['read', { ...EVIDENCE, role: 'system' }],
    ['job', { job: { id: 'j1' }, evidence: [] }],
    ['propose', { proposalId: '' }],
  ] as const)('rejects a malformed %s result', async (method, data) => {
    const client = createBrainClient(transportReturning(data).transport)
    const calls = {
      search: () => client.search({ query: 'q' }),
      read: () => client.read('ev1'),
      job: () => client.job(),
      propose: () => client.propose({ entities: [], claims: [], rationale: '' }),
    }
    const error: unknown = await calls[method]().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BrainClientError)
    expect((error as BrainClientError).code).toBe('malformed')
  })

  it('passes transport errors through unchanged', async () => {
    const failure = new BrainClientError('timeout', 'Brain request timed out')
    const request = vi.fn<BrainTransport['request']>().mockRejectedValue(failure)
    await expect(createBrainClient({ request }).brief('q')).rejects.toBe(failure)
  })
})
