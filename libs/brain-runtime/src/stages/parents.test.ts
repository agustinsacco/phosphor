import { writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { ModelCallInput } from '../model-call'
import { extractJob } from '../extract'
import { pipelineSetup, answerFor } from '../__fixtures__/pipeline'
import { prefixGroups, findParents } from './parents'
import { makeWindow } from '../windows'
import type { StageEntity, StageAsk } from '../stage-types'
import type { FoldedJob } from './fold'
import { FakeBrainStore } from '../__fixtures__/fake-store'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f()
})
const entity = (ref: string, label: string): StageEntity => ({
  ref,
  label,
  kind: 'component',
  description: '',
  aliases: [],
  keys: [],
})
it('groups at least three prefix siblings only when no parent is supported', () => {
  const entities = ['Harbor CS', 'Harbor Ledger', 'Harbor Docs'].map((label, i) => ({
    ...entity(`n${i}`, label),
    decision: 'new' as const,
    entityId: null,
    candidates: [],
    reason: '',
    auto: true,
  }))
  const job: FoldedJob = { entities, claims: [], parents: [], evidence: [], outcomes: [] }
  expect(prefixGroups(job, entities)[0]!.members).toEqual(['n0', 'n1', 'n2'])
  job.parents = [{ entity: 'n0', status: 'stated', claim: 'c1' }]
  expect(prefixGroups(job, entities)).toEqual([])
})
it('requires a parent answer for every requested entity and bounds co-mentioned segments', async () => {
  const e = entity('n1', 'Harbor workflow'),
    job: FoldedJob = { entities: [e], claims: [], parents: [], evidence: [], outcomes: [] }
  const segments = [
    {
      entryId: 'u',
      role: 'user' as const,
      label: 'You',
      observedAt: 0,
      text: 'Harbor workflow '.repeat(4000),
    },
  ]
  const ask: StageAsk = async (_s, _p, prompt, validate) => {
    expect(prompt.length).toBeLessThan(26000)
    return validate(JSON.stringify({ entities: [], claims: [], parents: [] }))
  }
  await expect(findParents(job, [], segments, new FakeBrainStore(), ask)).rejects.toThrow(
    'Missing parent assessment',
  )
  expect(makeWindow(segments).text.length).toBeGreaterThan(32000)
})
it('resolves only newly discovered parents against the store without revisiting earlier identities', async () => {
  const s = await pipelineSetup()
  cleanup.push(s.cleanup)
  const source = 'Harbor workflow is part of Harbor.'
  await writeFile(
    s.file,
    s.entries
      .map((e) =>
        JSON.stringify(e.id === 'user' ? { ...e, message: { role: 'user', content: source } } : e),
      )
      .join('\n'),
  )
  s.store.cards = [
    {
      id: 'harbor-org',
      label: 'Harbor',
      kind: 'organization',
      aliases: [],
      description: 'Customer',
      neighbours: [],
      memories: 2,
    },
  ]
  vi.spyOn(s.store, 'entityMatches').mockImplementation((probes) =>
    probes.map((p) =>
      p.label === 'Harbor' ? [{ entityId: 'harbor-org', channel: 'name', score: 1 }] : [],
    ),
  )
  s.runner.mockImplementation(parentAnswer)
  await extractJob(s.job, new AbortController().signal, s.store, s.options, s.search)
  const p = s.store.storedProposal(s.job.id)!
  expect(p.entities.find((e) => e.label === 'Harbor')).toMatchObject({
    decision: 'reuse',
    entityId: 'harbor-org',
  })
  expect(p.entities.filter((e) => e.label === 'Harbor' && e.decision === 'new')).toEqual([])
  const call = s.store.extraction(s.job.id).calls.find((c) => c.stage === 'identity')!
  expect(
    JSON.parse(s.store.part(s.job.id, `input:identity:${call.part}`, call.inputHash)!.output),
  ).toMatchObject({ pass: 'parents' })
})

async function parentAnswer(input: ModelCallInput) {
  const source = 'Harbor workflow is part of Harbor.'
  const quote = { segment: 's1', quote: source }
  let text = answerFor(input)
  if (input.stage === 'extract')
    text = JSON.stringify({
      entities: [entity('n1', 'Harbor workflow')],
      claims: [
        {
          ref: 'c1',
          text: source,
          type: 'fact',
          epistemic: 'reported',
          mentions: ['n1'],
          links: [],
          quotes: [quote],
          validFrom: null,
          validTo: null,
          branch: false,
        },
      ],
      parents: [{ entity: 'n1', status: 'not_stated', claim: null }],
    })
  if (input.stage === 'parents')
    text = JSON.stringify({
      entities: [{ ...entity('n1', 'Harbor'), kind: 'organization' }],
      claims: [
        {
          ref: 'c1',
          text: source,
          type: 'fact',
          epistemic: 'reported',
          mentions: ['r1', 'n1'],
          links: [{ subject: 'r1', predicate: 'part_of', object: 'n1', ...quote }],
          quotes: [quote],
          validFrom: null,
          validTo: null,
          branch: false,
        },
      ],
      parents: [{ entity: 'r1', status: 'stated', claim: 'c1' }],
    })
  if (input.stage === 'identity') {
    const rows = JSON.parse(input.prompt.slice(input.prompt.indexOf('\n') + 1)) as {
      entity: { ref: string }
      candidates: { handle: string; id: string }[]
    }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.entity.ref).toContain('parents')
    text = JSON.stringify({
      decisions: rows.map((r) => ({
        ref: r.entity.ref,
        action: 'reuse',
        candidate: r.candidates.find((c) => c.id === 'harbor-org')!.handle,
        reason: 'Same customer',
      })),
    })
  }
  return { text, usage: { tokens: 1, cost: 0 } }
}

it('reuses a unique allowed prefix parent, leaves duplicates unresolved, and prefers a job ref',()=>{
  const siblings=['Harbor CS','Harbor Ledger','Harbor Docs'].map((label,i)=>({...entity(`n${i+1}`,label),decision:'new' as const,entityId:null,candidates:[],reason:'',auto:true}))
  const job:FoldedJob={entities:siblings,claims:[],parents:[],evidence:[],outcomes:[]},store=new FakeBrainStore()
  store.cards=[{id:'harbor-org',label:'Harbor',kind:'organization',description:'',aliases:[],neighbours:[],memories:3}]
  store.matches=[[{entityId:'harbor-org',channel:'name',score:1}]]
  expect(prefixGroups(job,siblings,store)[0]!.parent.entityId).toBe('harbor-org')
  store.cards.push({...store.cards[0]!,id:'harbor-project',kind:'project'});store.matches[0]!.push({entityId:'harbor-project',channel:'name',score:1})
  expect(prefixGroups(job,siblings,store)[0]!.parent.entityId).toBeNull()
  const parent={...siblings[0]!,ref:'new-parent',label:'Harbor',kind:'project' as const}
  expect(prefixGroups(job,[...siblings,parent],store)[0]!.parent.entityId).toBe('new-parent')
})
