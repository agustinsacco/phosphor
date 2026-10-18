import { describe, it, expect } from 'vitest'
import {
  familyKey,
  familyLabel,
  groupModels,
  highlightRanges,
  modelKey,
  parseQuery,
  providerAliases,
  searchModels,
  squash,
  stripRegionSuffix,
  tokenize,
  type SearchableModel,
} from './modelSearch'

const model = (
  provider: string,
  id: string,
  name: string,
  extra: Partial<SearchableModel> = {},
): SearchableModel => ({ provider, id, name, ...extra })

/**
 * The catalogue shape that motivated this module: one model, five routes,
 * plus unrelated entries that must not be dragged in by a loose match.
 */
const CATALOGUE: SearchableModel[] = [
  model('anthropic', 'claude-opus-5', 'Claude Opus 5', { reasoning: true }),
  model('pi-claude-cli', 'claude-opus-5', 'Claude Opus 5', { reasoning: true }),
  model('amazon-bedrock', 'anthropic.claude-opus-5', 'Claude Opus 5', { reasoning: true }),
  model('amazon-bedrock', 'us.anthropic.claude-opus-5', 'Claude Opus 5 (US)', { reasoning: true }),
  model('amazon-bedrock', 'eu.anthropic.claude-opus-5', 'Claude Opus 5 (EU)', { reasoning: true }),
  model('anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', { reasoning: true }),
  model('anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5'),
  model('openai', 'gpt-5', 'GPT-5', { reasoning: true }),
  model('amazon-bedrock', 'amazon.nova-pro-v1:0', 'Nova Pro'),
  model('local-stark', 'Qwen 3.5 122b', 'Qwen 3.5 122b'),
]

const keysFor = (query: string, models = CATALOGUE): string[] =>
  searchModels(query, models).map((r) => r.key)

describe('tokenize / squash', () => {
  it('splits on every separator', () => {
    expect(tokenize('us.anthropic.claude-opus-5')).toEqual([
      'us',
      'anthropic',
      'claude',
      'opus',
      '5',
    ])
  })

  it('squashes separators away', () => {
    expect(squash('claude-opus-5')).toBe('claudeopus5')
    expect(squash('Claude Opus 5')).toBe('claudeopus5')
  })
})

describe('searchModels', () => {
  it('finds one model across every provider that offers it', () => {
    const keys = keysFor('opus 5')
    expect(keys).toEqual(
      expect.arrayContaining([
        'anthropic/claude-opus-5',
        'pi-claude-cli/claude-opus-5',
        'amazon-bedrock/anthropic.claude-opus-5',
        'amazon-bedrock/us.anthropic.claude-opus-5',
        'amazon-bedrock/eu.anthropic.claude-opus-5',
      ]),
    )
    expect(keys).not.toContain('openai/gpt-5')
  })

  it('is order-free: "bedrock opus" and "opus bedrock" agree', () => {
    expect(new Set(keysFor('bedrock opus'))).toEqual(new Set(keysFor('opus bedrock')))
  })

  it('narrows to one provider when a provider term is added', () => {
    // The regression this module exists for: five identical rows, and the only
    // way to reach the Bedrock ones was to know their id spelling.
    const keys = keysFor('opus bedrock')
    expect(keys).toEqual([
      'amazon-bedrock/anthropic.claude-opus-5',
      'amazon-bedrock/eu.anthropic.claude-opus-5',
      'amazon-bedrock/us.anthropic.claude-opus-5',
    ])
  })

  it('treats separators as noise', () => {
    const expected = new Set(keysFor('opus 5'))
    expect(new Set(keysFor('opus-5'))).toEqual(expected)
    expect(new Set(keysFor('opus5'))).toEqual(expected)
    expect(new Set(keysFor('OPUS 5'))).toEqual(expected)
  })

  it('requires every term to match', () => {
    expect(keysFor('opus gpt')).toEqual([])
  })

  it('ranks an exact name match above an incidental id match', () => {
    const results = searchModels('nova', CATALOGUE)
    expect(results[0]?.key).toBe('amazon-bedrock/amazon.nova-pro-v1:0')
  })

  it('ranks the plain provider route above the region profiles for a bare query', () => {
    // Same score band, so the tiebreak (shorter id first) decides — the
    // canonical `claude-opus-5` must not sit below an ARN-shaped sibling.
    const first = searchModels('opus', CATALOGUE)[0]
    expect(first?.model.id).toBe('claude-opus-5')
  })

  it('matches provider aliases nobody spells out in full', () => {
    expect(keysFor('aws opus').length).toBe(3)
    expect(keysFor('claude code opus')).toContain('pi-claude-cli/claude-opus-5')
  })

  it('supports quoted phrases', () => {
    expect(keysFor('"claude code" opus')).toEqual(['pi-claude-cli/claude-opus-5'])
  })

  it('supports field qualifiers', () => {
    expect(keysFor('provider:bedrock opus').length).toBe(3)
    expect(keysFor('name:opus').length).toBe(5)
    // `name:` must not leak into the id: only Bedrock ids carry "anthropic.".
    expect(keysFor('name:anthropic')).toEqual([])
    // A two-character term must land on a boundary: `us` inside `op[us]`
    // used to drag in every Opus route.
    expect(keysFor('id:us.')).toEqual(['amazon-bedrock/us.anthropic.claude-opus-5'])
  })

  it('resolves provider aliases through a provider: qualifier', () => {
    expect(keysFor('provider:aws').length).toBe(4)
  })

  it('negates with a leading dash', () => {
    const keys = keysFor('opus -bedrock')
    expect(keys).toEqual(['anthropic/claude-opus-5', 'pi-claude-cli/claude-opus-5'])
  })

  it('filters on is:reasoning', () => {
    expect(keysFor('is:reasoning claude')).not.toContain('anthropic/claude-haiku-4-5-20251001')
  })

  it('filters on is:starred and is:recent from context', () => {
    const context = { starred: new Set(['openai/gpt-5']), recent: new Set(['anthropic/gpt-5']) }
    expect(searchModels('is:starred', CATALOGUE, context).map((r) => r.key)).toEqual([
      'openai/gpt-5',
    ])
    // `is:recent` keys on provider/id, so a remembered route that no longer
    // exists matches nothing rather than the same-named model elsewhere.
    expect(searchModels('is:recent', CATALOGUE, context)).toEqual([])
  })

  it('matches nothing for an unknown flag rather than everything', () => {
    expect(searchModels('is:nonsense', CATALOGUE)).toEqual([])
  })

  it('does not treat a colon inside an id as a qualifier', () => {
    expect(keysFor('amazon.nova-pro-v1:0')).toEqual(['amazon-bedrock/amazon.nova-pro-v1:0'])
  })

  it('still falls back to a subsequence for a mistyped run', () => {
    expect(keysFor('clopus')).toContain('anthropic/claude-opus-5')
  })

  it('returns everything in input order for an empty query', () => {
    const results = searchModels('', CATALOGUE)
    expect(results.map((r) => r.model.id)).toEqual(CATALOGUE.map((m) => m.id))
    expect(results.every((r) => r.score === 0)).toBe(true)
  })

  it('returns nothing when no model matches', () => {
    expect(keysFor('llama')).toEqual([])
  })
})

describe('parseQuery', () => {
  it('keeps quoted spaces and drops the quotes', () => {
    expect(parseQuery('"claude code" opus').terms.map((t) => t.value)).toEqual([
      'claude code',
      'opus',
    ])
  })

  it('marks negation and excludes it from highlighting', () => {
    const parsed = parseQuery('opus -bedrock')
    expect(parsed.terms[1]).toMatchObject({ value: 'bedrock', negated: true })
    expect(parsed.highlightTerms).toEqual(['opus'])
  })

  it('records the field for a qualified term', () => {
    expect(parseQuery('provider:aws').terms[0]).toMatchObject({
      value: 'aws',
      field: 'provider',
    })
  })
})

describe('familyKey', () => {
  it('collapses every route to the same model', () => {
    const keys = new Set(
      [
        model('anthropic', 'claude-opus-5', 'Claude Opus 5'),
        model('pi-claude-cli', 'claude-opus-5', 'Claude Opus 5'),
        model('amazon-bedrock', 'anthropic.claude-opus-5', 'Claude Opus 5'),
        model('amazon-bedrock', 'us.anthropic.claude-opus-5', 'Claude Opus 5 (US)'),
        model('amazon-bedrock', 'global.anthropic.claude-opus-5', 'Claude Opus 5 (Global)'),
      ].map(familyKey),
    )
    expect(keys).toEqual(new Set(['claudeopus5']))
  })

  it('ignores a release date stamp', () => {
    expect(familyKey(model('anthropic', 'claude-haiku-4-5-20251001', 'Haiku'))).toBe(
      familyKey(model('anthropic', 'claude-haiku-4-5', 'Haiku')),
    )
  })

  it('ignores a Bedrock version suffix', () => {
    expect(familyKey(model('amazon-bedrock', 'amazon.nova-pro-v1:0', 'Nova Pro'))).toBe('novapro')
  })

  it('keeps genuinely different models apart', () => {
    expect(familyKey(model('anthropic', 'claude-opus-5', 'a'))).not.toBe(
      familyKey(model('anthropic', 'claude-sonnet-5', 'b')),
    )
    expect(familyKey(model('anthropic', 'claude-opus-4', 'a'))).not.toBe(
      familyKey(model('anthropic', 'claude-opus-5', 'b')),
    )
  })

  it('never returns an empty key', () => {
    expect(familyKey(model('x', 'anthropic.', 'weird'))).toBeTruthy()
  })
})

describe('familyLabel', () => {
  it('drops the region suffix and takes the majority name', () => {
    expect(
      familyLabel([
        model('anthropic', 'claude-opus-5', 'Claude Opus 5'),
        model('amazon-bedrock', 'us.anthropic.claude-opus-5', 'Claude Opus 5 (US)'),
        model('amazon-bedrock', 'eu.anthropic.claude-opus-5', 'Claude Opus 5 (EU)'),
      ]),
    ).toBe('Claude Opus 5')
  })

  it('falls back to the id when a model has no name', () => {
    expect(familyLabel([model('x', 'some-model', '')])).toBe('some-model')
  })
})

describe('stripRegionSuffix', () => {
  it('removes only routing parentheticals', () => {
    expect(stripRegionSuffix('Claude Opus 5 (US)')).toBe('Claude Opus 5')
    expect(stripRegionSuffix('Claude Opus 5 (Global)')).toBe('Claude Opus 5')
    expect(stripRegionSuffix('Qwen 3.5 (122b)')).toBe('Qwen 3.5 (122b)')
  })
})

describe('groupModels', () => {
  it('collapses the five Opus routes into one family group', () => {
    const groups = groupModels(searchModels('opus', CATALOGUE), 'family', true)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.label).toBe('Claude Opus 5')
    expect(groups[0]?.items).toHaveLength(5)
  })

  it('orders families by their best member when searching', () => {
    const groups = groupModels(searchModels('claude', CATALOGUE), 'family', true)
    expect(groups.map((g) => g.label)).toContain('Claude Opus 5')
    expect(groups[0]!.score).toBeGreaterThanOrEqual(groups[groups.length - 1]!.score)
  })

  it('orders alphabetically when idle, for a list that does not jump', () => {
    const groups = groupModels(searchModels('', CATALOGUE), 'provider', false)
    expect(groups.map((g) => g.label)).toEqual([
      'amazon-bedrock',
      'anthropic',
      'local-stark',
      'openai',
      'pi-claude-cli',
    ])
  })

  it('labels provider groups with the raw provider id, never a prettified one', () => {
    const groups = groupModels(searchModels('opus', CATALOGUE), 'provider', true)
    expect(groups.map((g) => g.label)).toContain('pi-claude-cli')
  })
})

describe('highlightRanges', () => {
  it('marks each occurrence of a term', () => {
    expect(highlightRanges('Claude Opus 5', 'opus')).toEqual([{ start: 7, end: 11 }])
  })

  it('marks the parts of a hyphenated term', () => {
    expect(highlightRanges('Claude Opus 5', 'opus-5')).toEqual([
      { start: 7, end: 11 },
      { start: 12, end: 13 },
    ])
  })

  it('merges overlapping ranges', () => {
    expect(highlightRanges('opusopus', 'opus opusopus')).toEqual([{ start: 0, end: 8 }])
  })

  it('ignores negated and qualified terms', () => {
    expect(highlightRanges('amazon-bedrock', 'opus -bedrock')).toEqual([])
    expect(highlightRanges('amazon-bedrock', 'provider:bedrock')).toEqual([])
  })

  it('returns nothing for an empty query', () => {
    expect(highlightRanges('Claude Opus 5', '')).toEqual([])
  })
})

describe('providerAliases / modelKey', () => {
  it('knows the providers that ship the same models', () => {
    expect(providerAliases('amazon-bedrock')).toContain('aws')
    expect(providerAliases('pi-claude-cli')).toContain('claude')
  })

  it('guesses from the shape for an unknown provider package', () => {
    expect(providerAliases('my-claude-thing')).toContain('claude')
    expect(providerAliases('local-stark')).toContain('local')
  })

  it('keys a model by provider and id together', () => {
    expect(modelKey(model('anthropic', 'claude-opus-5', 'x'))).toBe('anthropic/claude-opus-5')
  })
})
