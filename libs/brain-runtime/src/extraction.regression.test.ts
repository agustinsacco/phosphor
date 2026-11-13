import { describe, expect, it } from 'vitest'
import { parseExtraction } from './extraction'
import { RAW_EXTRACTION } from './__fixtures__/lane'

const parse = (value: unknown) => parseExtraction(JSON.stringify(value))

describe('extraction link regressions', () => {
  it('keeps a supported link when the sentence names the project another way', () => {
    const memory = {
      ...RAW_EXTRACTION.memories[0]!,
      summary: 'Rina Okafor owns the customer-service workflow.',
    }
    const parsed = parse({ ...RAW_EXTRACTION, memories: [memory] })
    expect(parsed.memories[0]).toMatchObject({ predicate: 'owns', object: 'harbor' })
  })
})
