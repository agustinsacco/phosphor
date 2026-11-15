import { writeFile } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { approve, extraction, fixture } from '@phosphor/memory-engine/test-support'
import { pipelineSetup, answerFor } from './__fixtures__/pipeline'
import { extractJob } from './extract'

it.each([false, true])(
  'only source-supported entity keys auto-reuse a stored identity (stated=%s)',
  async (stated) => {
    const s = await pipelineSetup()
    afterEach(s.cleanup)
    const { store } = fixture()
    const seed = extraction('')
    seed.entities.find((e) => e.ref === 'rina')!.keys = [{ namespace: 'staff', value: 'RINA 27' }]
    approve(store, { entities: seed.entities })
    const oldRina = store.overview(300).nodes.find((e) => e.label === 'Rina Okafor')!.id
    const source = `The build is green.${stated ? ' Staff key: rina\n  27.' : ''}`
    await writeFile(
      s.file,
      [
        ...s.entries.slice(0, 3),
        { type: 'message', id: 'B', message: { role: 'user', content: source } },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    )
    s.runner.mockImplementation(async (input) => ({
      text:
        input.stage === 'extract'
          ? JSON.stringify({
              entities: [
                {
                  ref: 'n1',
                  label: 'Unstated Owner',
                  kind: 'person',
                  aliases: [],
                  description: 'Build owner',
                  keys: [{ namespace: 'staff', value: 'RINA 27' }],
                },
              ],
              claims: [
                {
                  ref: 'c1',
                  text: 'The build is green.',
                  type: 'fact',
                  epistemic: 'reported',
                  mentions: ['n1'],
                  links: [],
                  quotes: [{ segment: 's1', quote: 'The build is green.' }],
                  validFrom: null,
                  validTo: null,
                  branch: false,
                },
              ],
              parents: [],
            })
          : answerFor(input),
      usage: { tokens: 1, cost: 0 },
    }))
    const job = store.enqueue({ ...s.job, sessionId: 'other-lane' }, 'queued')
    await extractJob(job, new AbortController().signal, store, s.options, s.search)
    const identity = store.storedProposal(job.id)!.entities[0]!
    expect(identity.entityId).toBe(stated ? oldRina : null)
    expect(identity.keys).toEqual(stated ? [{ namespace: 'staff', value: 'RINA 27' }] : [])
    if (stated) expect(identity).toMatchObject({ decision: 'reuse', auto: true })
    else
      expect(store.extraction(job.id).outcomes).toContainEqual(
        expect.objectContaining({
          candidate: 'w1:n1',
          status: 'dropped',
          summary: expect.stringContaining('RINA 27'),
          reason: expect.stringContaining('key value not found'),
        }),
      )
  },
)
