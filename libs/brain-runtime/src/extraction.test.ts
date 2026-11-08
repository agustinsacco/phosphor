import { describe, expect, it } from 'vitest'
import { parseExtraction } from './extraction'
import { RAW_EXTRACTION } from './__fixtures__/lane'

const parse = (value: unknown) => parseExtraction(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``)

describe('parseExtraction', () => {
  it('strips surrounding text and fences, normalises vocabulary and parses valid calendar dates', () => {
    const value = structuredClone(RAW_EXTRACTION)
    const json = {
      ...value,
      entities: value.entities.map((e) => ({ ...e, kind: e.kind.toUpperCase() })),
      memories: value.memories.map((m) => ({
        ...m,
        kind: 'REPORTED',
        type: 'FACT',
        predicate: 'OWNS',
        validFrom: '2026-11-06',
      })),
    }
    expect(parse(json)).toEqual({
      ...value,
      memories: value.memories.map((m) => ({ ...m, validFrom: Date.parse('2026-11-06') })),
    })
    expect(
      parse({ ...json, memories: [{ ...json.memories[0], validFrom: '2026-02-30' }] }).memories[0]!
        .validFrom,
    ).toBeNull()
  })

  it('drops bad shapes, unknown subjects and unknown vocab without throwing', () => {
    const valid = RAW_EXTRACTION.memories[0]!
    const value = {
      ...RAW_EXTRACTION,
      entities: [...RAW_EXTRACTION.entities, { key: 'x', label: 'X', kind: 'alien', aliases: [] }],
      memories: [
        valid,
        null,
        { ...valid, subject: 'missing' },
        { ...valid, predicate: 'manages' },
        { ...valid, type: 'task' },
        { ...valid, kind: 'guessed' },
        { ...valid, branch: 'false' },
      ],
    }
    expect(parse(value)).toEqual(RAW_EXTRACTION)
    expect(parse({ summary: 'Harbor', entities: {}, memories: [] }).memories).toEqual([])
    expect(parseExtraction('{bad json}')).toEqual({ summary: '', entities: [], memories: [] })
    expect(() => parseExtraction('No memories today.')).toThrow('The extraction returned no JSON.')
  })

  it('keeps a link only when both entity labels or aliases appear as whole phrases', () => {
    const valid = RAW_EXTRACTION.memories[0]!
    const value = {
      ...RAW_EXTRACTION,
      memories: [
        { ...valid, summary: 'Rina owns HARBOR.' },
        { ...valid, summary: 'Rina owns Harbors.' },
        { ...valid, summary: 'Rina Okafor chose seven years.' },
        { ...valid, object: 'unknown' },
      ],
    }
    const memories = parse(value).memories
    expect(memories[0]!.object).toBe('harbor')
    for (const m of memories.slice(1))
      expect(m).toMatchObject({ predicate: 'about', object: null, literal: null })
  })

  it('accepts existing entity ids and caps entities, memories and quote sizes', () => {
    const valid = RAW_EXTRACTION.memories[0]!
    const value = {
      ...RAW_EXTRACTION,
      memories: Array.from({ length: 25 }, () => ({ ...valid, quotes: ['a', 'b', 'c'] })),
    }
    const parsed = parseExtraction(JSON.stringify(value), {
      maxEntities: 1,
      maxMemories: 2,
      existingEntities: [{ id: 'harbor', label: 'Harbor', kind: 'project', aliases: [] }],
    })
    expect(parsed.entities).toHaveLength(1)
    expect(parsed.memories).toHaveLength(2)
    expect(parsed.memories[0]!.quotes).toEqual(['a', 'b'])
    expect(
      parse({ ...value, memories: [{ ...valid, quotes: ['x'.repeat(161), 'valid'] }] }).memories[0]!
        .quotes,
    ).toEqual(['valid'])
    expect(parse(value).memories).toHaveLength(20)
  })
})
