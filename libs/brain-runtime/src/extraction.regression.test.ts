import { describe, expect, it } from 'vitest'
import { parseStageExtraction } from './stage-parse'
import { makeWindow } from './windows'
import { RAW_EXTRACTION } from './__fixtures__/lane'
const window = makeWindow([
  {
    entryId: 'u',
    role: 'user',
    label: 'You',
    observedAt: 0,
    text: 'Rina Okafor owns Harbor billing.',
  },
])
const parse = (value: unknown) => parseStageExtraction(JSON.stringify(value), window)

describe('extraction link regressions', () => {
  it('keeps a supported link when the sentence names the project another way', () => {
    const value = structuredClone(RAW_EXTRACTION)
    value.claims[0]!.text = 'Rina Okafor owns the customer-service workflow.'
    expect(parse(value).claims[0]!.links[0]).toMatchObject({ predicate: 'owns', object: 'n2' })
  })
  it('rejects an unknown object ref rather than silently changing it to about', () => {
    const value = structuredClone(RAW_EXTRACTION)
    value.claims[0]!.links[0]!.object = 'missing'
    expect(() => parse(value)).toThrow(/Unknown entity ref/)
  })
})
