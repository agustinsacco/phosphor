// Real v8 mock graph reads over a small fictional world. No disk or provider access.
/* global window, structuredClone */
import { MockExplorer } from '../../../../libs/client-ui/src/features/brain/mockExplorer.ts'
import { createMockBrain } from '../../../../libs/client-ui/src/features/brain/mockBrain.ts'
import { mockBrainJob } from '../../../../libs/client-ui/src/features/brain/mockBrainData.ts'
import { mockExtractionRecord } from '../../../../libs/client-ui/src/features/brain/mockExtractionRecord.ts'
import { mockAsk, mockRoutes } from '../../../../libs/client-ui/src/features/brain/mockRecall.ts'
import fixture from './brain-demo.json'

export function installBrainDemo() {
  const explorer = new MockExplorer()
  explorer.entities = structuredClone(fixture.entities)
  explorer.details = structuredClone(fixture.details)
  const job = mockBrainJob({
    id: 'handover',
    sessionId: 'harbor-handover',
    sessionPath: '/demo/Harbor/handover.jsonl',
    title: 'Harbor handover',
  })
  const record = savedRecord(job, explorer)
  const changes = savedChanges(job, record)
  const brain = createMockBrain(() => Date.now(), { count: 0 })
  const invoke = window.phosphor.invoke.bind(window.phosphor)
  window.phosphor.invoke = async (channel, ...args) => {
    if (!channel.startsWith('brain:')) return invoke(channel, ...args)
    if (channel === 'brain:tidyChanges') return structuredClone(changes)
    if (channel === 'brain:extraction' && args[0] === job.id) return structuredClone(record)
    const read = explore(explorer, channel, args)
    if (read !== undefined) return structuredClone(read)
    const result = await brain(channel, args)
    if (result?.embedding && result?.counts) {
      result.ownerId = fixture.ownerId
      result.counts = { memories: explorer.details.length, entities: explorer.entities.length }
      result.jobs = result.jobs.filter((item) => item.state !== 'failed')
    }
    return result
  }
}

function explore(explorer, channel, args) {
  switch (channel) {
    case 'brain:overview':
      return explorer.graph(null)
    case 'brain:neighbourhood':
      return explorer.graph(...args)
    case 'brain:find':
      return explorer.find(...args)
    case 'brain:entity':
      return explorer.entity(...args)
    case 'brain:memory':
      return explorer.memory(...args)
    case 'brain:entityMemories':
      return explorer.memories(...args)
    case 'brain:path':
      return mockRoutes(explorer, ...args)
    case 'brain:ask': {
      // Stage a short answer. Keep the mock's ranking, evidence and full trail for each hit.
      const answer = mockAsk(explorer, ...args)
      const hits = answer.hits.slice(0, 2)
      return { ...answer, hits, more: answer.more + answer.hits.length - hits.length }
    }
  }
}

// Both journal entries and the extraction dialog describe the memories actually on the map.
function savedRecord(job, explorer) {
  const notes = explorer.details.filter(({ memory }) => memory.jobId === job.id)
  const record = mockExtractionRecord(job, 'low', job.finishedAt)
  record.memories = notes.map(({ memory: { id, summary } }) => ({ id, summary }))
  record.outcomes = record.memories.map(({ id, summary }, index) => ({
    candidate: `w1:c${index + 1}`,
    memoryId: id,
    summary,
    status: 'kept',
    proposalIndex: index,
  }))
  const quotes = notes.map(({ quotes }) => quotes[0].quote)
  record.source.exists = true
  record.source.segments = [{ label: 'You · Harbor handover', text: quotes.join('\n') }]
  record.calls[0].answer = JSON.stringify({
    claims: record.memories.map(({ summary }, index) => ({ summary, quote: quotes[index] })),
  })
  record.calls[1].answer = JSON.stringify({
    links: notes.flatMap(({ memory }) => memory.links.filter((link) => link.statedBy === 'reader')),
  })
  return record
}

function savedChanges(job, record) {
  const base = { undoneAt: null, undoable: true, suggestionId: null }
  return {
    revision: 2,
    items: [
      {
        ...base,
        id: 'relate-handover',
        kind: 'relate',
        who: 'agent',
        runId: 'handover-check',
        jobId: null,
        summary: record.memories[0].summary,
        reason: 'The handover note names both the new lead and the previous lead.',
        createdAt: job.finishedAt + 60_000,
      },
      {
        ...base,
        id: 'read-handover',
        kind: 'read',
        who: 'automatic',
        runId: null,
        jobId: job.id,
        summary: `Read ${job.title}: ${record.memories.length} memories`,
        reason: null,
        createdAt: job.finishedAt,
      },
    ],
  }
}
