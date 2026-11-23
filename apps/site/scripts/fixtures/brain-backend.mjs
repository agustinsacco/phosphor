// Capture-only adapter. Reuses the app's mock lifecycle and graph algorithms, never a DB.
/* global window, structuredClone */
import { MockExplorer } from '../../../../libs/client-ui/src/features/brain/mockExplorer.ts'
import { createMockBrain } from '../../../../libs/client-ui/src/features/brain/mockBrain.ts'
import fixture from './brain-demo.json'

export function installBrainDemo() {
  const explorer = new MockExplorer()
  explorer.entities = structuredClone(fixture.entities)
  explorer.details = structuredClone(fixture.details)
  const invoke = window.phosphor.invoke.bind(window.phosphor)
  const brain = createMockBrain(() => Date.now(), { count: 0 })
  window.phosphor.invoke = async (channel, ...args) => {
    const read = explorerRead(explorer, channel, args)
    if (read !== undefined) return structuredClone(read)
    const result = channel.startsWith('brain:')
      ? await brain(channel, args)
      : await invoke(channel, ...args)
    if (channel === 'brain:proposal') {
      // Stage a waiting read, not a decision or a completed Defrag run.
      result.identities = result.identities.map((identity) => ({
        ...identity,
        ...fixture.entities.find((entity) => entity.id === identity.ref),
      }))
      result.groups = []
      result.memories = result.memories.map((memory, index) => ({
        ...memory,
        action: 'enrich',
        target: { id: `memory-${index}`, summary: fixture.details[index].memory.summary },
        reason: 'Adds the pilot-planning source as supporting evidence.',
        quotes: fixture.details[index].quotes,
      }))
    }
    if (channel === 'brain:extraction') stageExtraction(result)
    if (result?.embedding && result?.counts) {
      result.counts = { memories: explorer.details.length, entities: explorer.entities.length }
      result.jobs = result.jobs
        .filter((job) => job.state !== 'failed')
        .map((job) => ({
          ...job,
          title: job.id === 'harbor-demo-review' ? 'Harbor pilot planning' : job.title,
        }))
      result.agent.waiting.reads = result.jobs.filter((job) =>
        ['review', 'refreshing'].includes(job.state),
      ).length
    }
    return result
  }
}
function explorerRead(explorer, channel, args) {
  switch (channel) {
    case 'brain:overview':
      return explorer.graph(null)
    case 'brain:neighbourhood':
      return explorer.graph(args[0], args[1])
    case 'brain:find':
      return explorer.find(args[0], args[1])
    case 'brain:entities':
      return explorer.browse(...args)
    case 'brain:recent':
      return explorer.recent(args[0])
    case 'brain:entity':
      return explorer.entity(args[0])
    case 'brain:memory':
      return explorer.memory(args[0])
    case 'brain:entityMemories':
      return explorer.memories(...args)
    case 'brain:connections':
      return explorer.connections(...args)
    case 'brain:path':
      return explorer.path(...args)
    default:
      return undefined
  }
}
function stageExtraction(result) {
  if (result.jobId === 'harbor-demo-review') result.title = 'Harbor pilot planning'
  result.finishedAt = result.startedAt + 48_000
  const claims = fixture.details.slice(0, 2).map(({ memory, quotes }, index) => ({
    id: `c${index + 1}`,
    summary: memory.summary,
    quote: quotes[0].quote,
  }))
  result.outcomes = claims.map((claim, index) => ({
    candidate: `w1:${claim.id}`,
    summary: claim.summary,
    status: 'enriches',
    proposalIndex: index,
  }))
  result.outcomes.push({
    candidate: 'w1:c3',
    summary: 'Unverified release date',
    status: 'dropped',
    reason: 'No supporting quote in the pilot-planning source.',
  })
  result.calls[0].answer = JSON.stringify({ claims })
  result.calls[1].answer = JSON.stringify({
    links: fixture.details.slice(0, 2).map(({ memory, quotes }) => ({
      ...memory.links[0],
      quote: quotes[0].quote,
    })),
  })
  result.source.title = 'Harbor pilot planning'
}
