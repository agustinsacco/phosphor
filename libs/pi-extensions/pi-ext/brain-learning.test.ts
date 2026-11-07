import { describe, expect, it, vi } from 'vitest'
import fixture from '@phosphor/brain-runtime/__fixtures__/learning-source/pi-1.4-projection.json'
import { runBrainLearning, type BrainLearningPort } from './brain-learning'
import { learningHash, learningSuffix, projectLearningContext } from './brain-learning-context'
import { learningUsage, resolveLearningOutcome } from './brain-learning-result'
import type { BrainLearningRequest } from '@phosphor/shared/brain-learning'

const binding: BrainLearningRequest['binding'] = {
  provider: 'openai-codex',
  modelId: 'synthetic',
  api: 'openai-codex-responses',
  accountId: 'slot-1',
  authMode: 'oauth',
  thinkingLevel: 'high',
  endpoint: 'https://synthetic.invalid',
}
function setup(
  response: unknown = {
    role: 'assistant',
    stopReason: 'stop',
    content: [{ type: 'text', text: '{"type":"no_findings"}' }],
    usage: { input: 11, output: 7, cacheRead: 9, cacheWrite: 0, reasoning: 3 },
  },
) {
  const byId = new Map(fixture.entries.map((entry) => [entry.id, entry]))
  const branch: unknown[] = []
  let id: string | null = fixture.leafId
  while (id) {
    const entry: (typeof fixture.entries)[number] = byId.get(id)!
    branch.unshift(entry)
    id = entry.parentId
  }
  const entries = branch.map((raw) => {
    const entry = raw as { id: string; parentId: string | null }
    return {
      entryId: entry.id,
      parentId: entry.parentId,
      entryHash: learningHash(raw),
      rootId: learningHash(raw),
    }
  })
  const request: BrainLearningRequest = {
    version: 1,
    jobId: 'job-1',
    binding: { ...binding },
    source: {
      sessionId: 'original',
      selectedLeafId: fixture.leafId,
      sourceDigest: 'source-digest',
      contentDigest: learningHash(entries),
      entries,
    },
    alreadyCovered: [],
    suffixTimestamp: 123,
    deadlineMs: 1000,
    maxOutputTokens: 2000,
  }
  const execute = vi.fn()
  const streamSimple = vi.fn<BrainLearningPort['modelRegistry']['streamSimple']>(() => ({
    result: async () => response,
  }))
  const port: BrainLearningPort = {
    binding: { ...binding },
    mode: 'native',
    model: { provider: binding.provider, id: binding.modelId, api: binding.api },
    getActiveTools: () => [],
    sessionManager: {
      getLeafId: () => fixture.leafId,
      getBranch: () => structuredClone(branch),
      buildSessionProjection: () => structuredClone(fixture.projection),
    },
    convertToLlm: (messages) => {
      const index = fixture.projection.entries.findIndex(
        (entry) => JSON.stringify(entry.messages) === JSON.stringify(messages),
      )
      if (index < 0) throw new Error('Unexpected conversion input')
      return structuredClone(fixture.wireByEntry[index]!)
    },
    contextFits: () => true,
    modelRegistry: { streamSimple },
  }
  return { request, port, streamSimple, execute }
}
const outcome = (quote: string, role = 'user') =>
  JSON.stringify({
    type: 'findings',
    findings: [
      {
        subject: { label: 'Synthetic component', kind: 'component' },
        predicate: 'about',
        literal: 'durable learning',
        validFrom: null,
        validTo: null,
        summary: 'durable learning',
        kind: 'reported',
        citations: [{ role, quote }],
      },
    ],
  })

describe('brain-learning pi-side one logical generation', () => {
  it('uses pi 1.4 projected compaction/context edits, retaining the last assistant and thinking', () => {
    const { request, port } = setup()
    const context = projectLearningContext(request, port)
    const wire = JSON.stringify(context.messages)
    expect(context.evidence.find((item) => item.entryId === 'answer')?.rootIds).toEqual([
      'old',
      'keep',
      'omit',
    ])
    expect(context.evidence.find((item) => item.sourceType === 'compaction')?.rootIds).toEqual([
      'old',
      'keep',
      'omit',
    ])
    expect(context.checkpoint.rootIds).toEqual(['keep', 'old', 'omit'])
    expect(wire).toContain('final assistant fact')
    expect(wire).toContain('retained reasoning')
    expect(wire).toContain('sig')
    expect(wire).toContain('summary-only fact')
    expect(wire).toContain('edited eligible fact')
    for (const omitted of [
      'omitted ancient fact',
      'abandoned fact',
      'before edit',
      'explicitly context-omitted fact',
    ])
      expect(wire).not.toContain(omitted)
    expect(context.checkpoint.covered.map((entry) => entry.entryId)).toEqual([
      'compact',
      'keep',
      'answer',
    ])
    expect(context.evidence.find((item) => item.sourceType === 'compaction')?.text).toContain(
      'summary-only fact',
    )
    expect(resolveLearningOutcome(outcome('edited eligible fact'), context.evidence).type).toBe(
      'findings',
    )
    for (const quote of [
      'omitted ancient fact',
      'abandoned fact',
      'before edit',
      'explicitly context-omitted fact',
      'retained reasoning',
    ])
      expect(() => resolveLearningOutcome(outcome(quote), context.evidence)).toThrow(/citation/)
  })
  it('retains dependencies for image-only inputs and thinking-only generated context', () => {
    const { request, port } = setup()
    const branch = [
      {
        id: 'system',
        parentId: null,
        type: 'message',
        message: { role: 'system', content: 'system' },
      },
      {
        id: 'image',
        parentId: 'system',
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'image', mimeType: 'image/png', data: 'synthetic' }],
        },
      },
      {
        id: 'thinking',
        parentId: 'image',
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'retained internal plaintext' }],
        },
      },
    ]
    const entries = branch.map((entry) => ({
      entryId: entry.id,
      parentId: entry.parentId,
      entryHash: learningHash(entry),
      rootId: learningHash(entry),
    }))
    request.source = {
      ...request.source,
      selectedLeafId: 'thinking',
      entries,
      contentDigest: learningHash(entries),
    }
    port.sessionManager = {
      getLeafId: () => 'thinking',
      getBranch: () => branch,
      buildSessionProjection: () => ({
        entries: branch.map((entry) => ({ sourceEntry: entry, messages: [entry.message] })),
      }),
    }
    port.convertToLlm = (messages) =>
      structuredClone(messages) as ReturnType<typeof port.convertToLlm>
    const projected = projectLearningContext(request, port)
    expect(projected.evidence).toEqual([])
    expect(projected.checkpoint.rootIds).toEqual(['image'])
    expect(projected.checkpoint.covered.map((entry) => entry.entryId)).toEqual([
      'system',
      'image',
      'thinking',
    ])
    expect(JSON.stringify(projected.messages)).toContain('retained internal plaintext')
    expect(JSON.stringify(projected.messages)).toContain('image/png')
  })
  it('appends one deterministic final USER suffix, never edits source or replaces system/tools', async () => {
    const { request, port, streamSimple } = setup()
    const before = JSON.stringify({
      request,
      projection: port.sessionManager.buildSessionProjection(),
    })
    const expected = projectLearningContext(request, port)
    const result = await runBrainLearning(request, port, new AbortController().signal)
    expect(streamSimple).toHaveBeenCalledTimes(1)
    const [, context, options] = streamSimple.mock.calls[0] as unknown as [
      unknown,
      { messages: unknown[] },
      Record<string, unknown>,
    ]
    expect(context.messages.slice(0, -1)).toEqual(expected.messages)
    expect(context.messages.at(-1)).toEqual({
      role: 'user',
      content: learningSuffix(expected.evidence),
      timestamp: 123,
    })
    expect(options).toMatchObject({ maxRetries: 0, reasoning: 'high', maxTokens: 2000 })
    expect(options).not.toHaveProperty('metadata')
    expect(
      JSON.stringify({ request, projection: port.sessionManager.buildSessionProjection() }),
    ).toBe(before)
    expect(result.outcome).toEqual({ type: 'no_findings' })
    expect(result.usage).toEqual({
      input: 11,
      output: 7,
      cacheRead: 9,
      cacheWrite: 0,
      reasoning: 3,
    })
    expect(result.execution).toMatchObject({
      logicalGenerations: 1,
      networkAttempts: null,
      serializedPrefixIdentical: false,
    })
  })
  it('freezes request identity while the response is in flight', async () => {
    const { request, port } = setup()
    const pending = runBrainLearning(request, port, new AbortController().signal)
    request.jobId = 'changed-job'
    request.binding.accountId = 'changed-slot'
    const result = await pending
    expect(result.jobId).toBe('job-1')
    expect(result.binding.accountId).toBe('slot-1')
  })
  it('returns exact resolved evidence for a valid finding without any executor', async () => {
    const { request, port, streamSimple, execute } = setup({
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: outcome('final assistant fact', 'assistant') }],
    })
    Object.assign(port, { executeTool: execute })
    const result = await runBrainLearning(request, port, new AbortController().signal)
    expect(result.outcome.type).toBe('findings')
    if (result.outcome.type !== 'findings') throw new Error('Expected findings')
    const citation = result.outcome.findings[0]!.citations[0]!
    expect(result.evidence.find((item) => item.evidenceId === citation.evidenceId)).toMatchObject({
      entryId: 'answer',
      text: citation.quote,
    })
    expect(result.binding).toEqual(binding)
    expect(execute).not.toHaveBeenCalled()
    expect(streamSimple).toHaveBeenCalledTimes(1)
  })
  it('sends the opted-in Claude metadata only on the attested Claude port', async () => {
    const { request, port, streamSimple } = setup()
    request.binding = { ...binding, provider: 'pi-claude-cli', authMode: 'cli' }
    port.binding = { ...request.binding }
    port.model.provider = 'pi-claude-cli'
    port.mode = 'claude-single-response'
    await runBrainLearning(request, port, new AbortController().signal)
    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ metadata: { piSingleResponse: 1 } })
  })
  it.each([
    [{ type: 'toolCall', name: 'bash', arguments: { command: 'bad' } }],
    [{ type: 'toolCall', name: 'unknown', arguments: {} }],
    [{ type: 'toolCall', name: 'bash', arguments: 'malformed' }],
    [
      { type: 'toolCall', name: 'one' },
      { type: 'toolCall', name: 'two' },
    ],
  ])('never dispatches or repairs emitted tools: %j', async (...blocks) => {
    const { request, port, streamSimple, execute } = setup({
      role: 'assistant',
      stopReason: 'stop',
      content: blocks,
    })
    Object.assign(port, { executeTool: execute })
    await expect(runBrainLearning(request, port, new AbortController().signal)).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
    expect(streamSimple).toHaveBeenCalledTimes(1)
  })
  it.each(['length', 'toolUse', 'error', 'aborted', 'pending', 'deferred'])(
    'stops on %s without another generation',
    async (stopReason) => {
      const { request, port, streamSimple } = setup({ role: 'assistant', stopReason, content: [] })
      await expect(runBrainLearning(request, port, new AbortController().signal)).rejects.toThrow()
      expect(streamSimple).toHaveBeenCalledTimes(1)
    },
  )
  it.each(['bad JSON', outcome('missing quote'), '{"type":"findings","findings":[]}'])(
    'rejects invalid output with no repair: %s',
    async (text) => {
      const { request, port, streamSimple } = setup({
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text }],
      })
      await expect(runBrainLearning(request, port, new AbortController().signal)).rejects.toThrow()
      expect(streamSimple).toHaveBeenCalledTimes(1)
    },
  )
  it('fails closed for ambiguous/wrong-role/already-covered citations', () => {
    const { request, port } = setup(),
      context = projectLearningContext(request, port)
    expect(() =>
      resolveLearningOutcome(outcome('edited eligible fact', 'assistant'), context.evidence),
    ).toThrow()
    expect(() =>
      resolveLearningOutcome(outcome('edited eligible fact'), [
        ...context.evidence,
        ...context.evidence,
      ]),
    ).toThrow()
    request.alreadyCovered = context.checkpoint.covered
    const covered = projectLearningContext(request, port)
    expect(() =>
      resolveLearningOutcome(outcome('edited eligible fact'), covered.evidence),
    ).toThrow()
    expect(learningSuffix(covered.evidence)).toContain('[]')
  })
  it('has the same projection digest before and after a metadata-only append', () => {
    const { request, port } = setup()
    const after = projectLearningContext(request, port)
    const branch = port.sessionManager.getBranch().slice(0, -1)
    request.source.entries.pop()
    request.source.contentDigest = learningHash(request.source.entries)
    request.source.selectedLeafId = 'omit-edit'
    port.sessionManager.getBranch = () => branch
    port.sessionManager.getLeafId = () => 'omit-edit'
    const projection = structuredClone(fixture.projection)
    projection.entries.pop()
    port.sessionManager.buildSessionProjection = () => projection
    expect(projectLearningContext(request, port).checkpoint.projectionDigest).toBe(
      after.checkpoint.projectionDigest,
    )
  })
  it('does not treat metadata or copied roots as new eligibility', async () => {
    const { request, port, streamSimple } = setup()
    request.alreadyCovered = projectLearningContext(request, port).checkpoint.covered
    request.source.sessionId = 'forked-copy'
    await expect(runBrainLearning(request, port, new AbortController().signal)).rejects.toThrow(
      /no new eligible/,
    )
    expect(streamSimple).not.toHaveBeenCalled()
  })
  it.each(['binding', 'model', 'tools', 'oversize', 'leaf', 'entry'])(
    'rejects failed admission: %s',
    async (reason) => {
      const { request, port, streamSimple } = setup()
      if (reason === 'binding') port.binding.accountId = 'wrong-slot'
      if (reason === 'model') port.model.id = 'fallback'
      if (reason === 'tools') port.getActiveTools = () => ['bash']
      if (reason === 'oversize') port.contextFits = () => false
      if (reason === 'leaf') port.sessionManager.getLeafId = () => 'other'
      if (reason === 'entry') request.source.entries[0]!.entryHash = 'bad'
      await expect(runBrainLearning(request, port, new AbortController().signal)).rejects.toThrow()
      expect(streamSimple).not.toHaveBeenCalled()
    },
  )
  it('calls stream once on thrown provider errors and cancellation, with no retries/fallbacks', async () => {
    const { request, port, streamSimple } = setup()
    streamSimple.mockImplementation(() => {
      throw new Error('provider failure')
    })
    await expect(runBrainLearning(request, port, new AbortController().signal)).rejects.toThrow(
      'provider failure',
    )
    expect(streamSimple).toHaveBeenCalledTimes(1)
    const controller = new AbortController()
    streamSimple.mockClear().mockImplementation(() => ({ result: () => new Promise(() => {}) }))
    const pending = runBrainLearning(request, port, controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
    expect(streamSimple).toHaveBeenCalledTimes(1)
  })
  it('enforces deadline and pre-cancellation', async () => {
    const { request, port, streamSimple } = setup()
    request.deadlineMs = 5
    streamSimple.mockImplementation(() => ({ result: () => new Promise(() => {}) }))
    await expect(runBrainLearning(request, port, new AbortController().signal)).rejects.toThrow(
      /deadline/,
    )
    expect(streamSimple).toHaveBeenCalledTimes(1)
    const controller = new AbortController()
    controller.abort()
    streamSimple.mockClear()
    await expect(runBrainLearning(request, port, controller.signal)).rejects.toThrow()
    expect(streamSimple).not.toHaveBeenCalled()
  })
  it('never substitutes cumulative or unavailable usage, or adds reasoning to output', () => {
    expect(learningUsage(undefined)).toEqual({
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
    })
    expect(learningUsage({ output: 10, reasoning: 3, totalTokens: 999_999 })).toMatchObject({
      output: 10,
      reasoning: 3,
      input: null,
    })
    expect(learningUsage({ output: 1, reasoning: 3 })).toMatchObject({ reasoning: null })
  })
})
