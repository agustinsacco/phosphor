import { expect, expectTypeOf, it } from 'vitest'
import {
  BRAIN_EMBEDDING_MODEL,
  BRAIN_PREDICATES,
  BRAIN_PROTOCOL,
  DEFAULT_BRAIN_PREFS,
  type BrainAgentMethod,
} from './brain'

it('starts disabled without enrolled sources, recall or a billable processor', () => {
  expect(DEFAULT_BRAIN_PREFS).toEqual({
    enabled: false,
    recall: false,
    workspaces: [],
    processor: null,
    retentionDays: 30,
  })
})

it('pins the prototype agent wire and does not expose approval or forgetting to models', () => {
  expect(BRAIN_PROTOCOL).toBe(1)
  expectTypeOf<BrainAgentMethod>().toEqualTypeOf<'search' | 'read' | 'brief' | 'job' | 'propose'>()
  expect(BRAIN_PREDICATES).toEqual(['owns', 'depends_on', 'blocks', 'affects', 'decided', 'about'])
})

it('identifies the measured local candidate and its separate use terms', () => {
  expect(BRAIN_EMBEDDING_MODEL.id).toBe(
    'embeddinggemma-300m-q4@5090578d9565bb06545b4552f76e6bc2c93e4a66',
  )
  expect(BRAIN_EMBEDDING_MODEL.downloadBytes).toBe(218_726_989)
  expect(BRAIN_EMBEDDING_MODEL.dimensions).toBe(768)
  expect(BRAIN_EMBEDDING_MODEL.termsUrl).toBe('https://ai.google.dev/gemma/terms')
  expect(BRAIN_EMBEDDING_MODEL.usePolicyUrl).toBe(
    'https://ai.google.dev/gemma/prohibited_use_policy',
  )
})
