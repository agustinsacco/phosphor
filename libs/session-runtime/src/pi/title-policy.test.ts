import { describe, expect, it } from 'vitest'
import {
  CLAUDE_TITLE_FALLBACK,
  dedupeTitle,
  pickTitleModel,
  sanitizeTitle,
  titleArgs,
  titleAttempts,
  titlePrompt,
  type TitleCandidate,
} from '@phosphor/session-runtime/pi/title-policy'

describe('titleArgs', () => {
  it('always strips tools, context files, skills and templates', () => {
    const args = titleArgs()
    for (const flag of [
      '-p',
      '--no-session',
      '--no-tools',
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
    ]) {
      expect(args).toContain(flag)
    }
    expect(args).not.toContain('--model')
  })

  it('always turns thinking off, whatever the default level', () => {
    const args = titleArgs({ model: CLAUDE_TITLE_FALLBACK })
    expect(args[args.indexOf('--thinking') + 1]).toBe('off')
  })

  it('names a model only with an explicit provider', () => {
    const args = titleArgs({ model: { provider: 'kimi-coding', id: 'kimi-k2-turbo' } })
    expect(args[args.indexOf('--provider') + 1]).toBe('kimi-coding')
    expect(args[args.indexOf('--model') + 1]).toBe('kimi-k2-turbo')
  })

  it('disables discovery only on a fast boot, loading the listed extensions', () => {
    // `-ne` alone makes pi-claude-cli an unknown provider, so a fast boot
    // must carry the provider's extension; a full boot must not use `-ne`.
    expect(titleArgs({ extensions: null })).not.toContain('--no-extensions')
    const args = titleArgs({ extensions: ['/pkg/index.ts'] })
    expect(args).toContain('--no-extensions')
    expect(args[args.indexOf('-e') + 1]).toBe('/pkg/index.ts')
  })
})

describe('pickTitleModel', () => {
  const m = (provider: string, id: string, input: number, output: number): TitleCandidate => ({
    provider,
    id,
    cost: { input, output },
  })
  const catalogue = [
    m('pi-claude-cli', 'claude-opus-5-5', 5, 25),
    m('pi-claude-cli', 'claude-haiku-4-5-20251001', 1, 5),
    m('pi-claude-cli', 'claude-haiku-4-5', 1, 5),
    m('pi-claude-cli', 'claude-haiku-5-5', 0.1, 0.5),
    m('amazon-bedrock', 'us.anthropic.claude-opus-4-1-v1:0', 15, 75),
    m('amazon-bedrock', 'us.anthropic.claude-haiku-4-5-v1:0', 1, 5),
    m('amazon-bedrock', 'anthropic.claude-3-haiku-v1:0', 0.25, 1.25),
    m('amazon-bedrock', 'mistral.voxtral-mini-3b-2507', 0.04, 0.04),
    m('amazon-bedrock', 'us.amazon.nova-micro-v1:0', 0.035, 0.14),
    m('openrouter', 'anthropic/claude-sonnet-5', 3, 15),
    m('openrouter', 'anthropic/claude-haiku-4-5', 1, 5),
    m('openrouter', 'google/gemma-4-31b-it:free', 0, 0),
    m('openrouter', 'openai/gpt-6-luna', 0.1, 0.5),
    m('kimi-coding', 'kimi-k2', 0.6, 2.5),
    m('kimi-coding', 'kimi-k2-turbo', 0.3, 1.2),
    m('local', 'qwen-local', 0, 0),
  ]

  it('picks the cheapest model of the default provider', () => {
    expect(pickTitleModel(catalogue, 'pi-claude-cli', 'claude-opus-5-5')).toEqual({
      provider: 'pi-claude-cli',
      id: 'claude-haiku-5-5',
    })
    expect(pickTitleModel(catalogue, 'kimi-coding', 'kimi-k2')?.id).toBe('kimi-k2-turbo')
  })

  it('stays in the default family and region, and skips non-chat models', () => {
    // Not voxtral (speech), not nova (another vendor), not the unprefixed
    // Claude 3 (a different inference profile than the user reaches).
    expect(
      pickTitleModel(catalogue, 'amazon-bedrock', 'us.anthropic.claude-opus-4-1-v1:0')?.id,
    ).toBe('us.anthropic.claude-haiku-4-5-v1:0')
    // Not the free tier, not another vendor through the same router.
    expect(pickTitleModel(catalogue, 'openrouter', 'anthropic/claude-sonnet-5')?.id).toBe(
      'anthropic/claude-haiku-4-5',
    )
  })

  it('prefers the alias over the dated snapshot at the same price', () => {
    const twins = catalogue.filter(
      (x) => x.id.startsWith('claude-haiku-4') || x.id.includes('opus-5'),
    )
    expect(pickTitleModel(twins, 'pi-claude-cli', 'claude-opus-5-5')?.id).toBe('claude-haiku-4-5')
  })

  it('keeps the default when it is already cheapest, unpriced or unknown', () => {
    expect(pickTitleModel(catalogue, 'kimi-coding', 'kimi-k2-turbo')).toBeNull()
    expect(pickTitleModel(catalogue, 'local', 'qwen-local')).toBeNull()
    expect(pickTitleModel(catalogue, 'kimi-coding', 'not-in-catalogue')).toBeNull()
    expect(pickTitleModel(catalogue, undefined, undefined)).toBeNull()
    expect(pickTitleModel([], 'pi-claude-cli', 'claude-opus-5-5')).toBeNull()
  })
})

describe('titleAttempts', () => {
  const haiku = { provider: 'pi-claude-cli', id: 'claude-haiku-5-5' }

  it('tries a fast boot, then a full boot, then the fallback model', () => {
    expect(titleAttempts(haiku, ['/ext.ts'], CLAUDE_TITLE_FALLBACK)).toEqual([
      { model: haiku, extensions: ['/ext.ts'] },
      { model: haiku, extensions: null },
      { model: CLAUDE_TITLE_FALLBACK, extensions: null },
    ])
  })

  it('drops duplicate runs', () => {
    expect(titleAttempts(null, null, null)).toEqual([{ model: null, extensions: null }])
    expect(titleAttempts(CLAUDE_TITLE_FALLBACK, null, CLAUDE_TITLE_FALLBACK)).toHaveLength(1)
  })
})

describe('titlePrompt', () => {
  it('carries the message and the existing names', () => {
    const prompt = titlePrompt('fix the sidebar resize handle', ['Sidebar Polish', 'Auth Bug'])
    expect(prompt).toContain('fix the sidebar resize handle')
    expect(prompt).toContain('- Sidebar Polish')
    expect(prompt).toContain('- Auth Bug')
  })

  it('omits the existing-names section when there are none', () => {
    expect(titlePrompt('hello', [])).not.toContain('Existing session names')
    expect(titlePrompt('hello', ['  '])).not.toContain('Existing session names')
  })

  it('caps a pathological first message', () => {
    const prompt = titlePrompt('x'.repeat(50_000), [])
    expect(prompt.length).toBeLessThan(2500)
  })
})

describe('sanitizeTitle', () => {
  it('takes the last non-empty line and strips wrapping', () => {
    expect(sanitizeTitle('Here is the name:\n\n"Sidebar Resize Fix."\n')).toBe('Sidebar Resize Fix')
  })

  it('passes a clean single line through', () => {
    expect(sanitizeTitle('Composer Autogrow Bug')).toBe('Composer Autogrow Bug')
  })

  it('collapses internal whitespace and caps length', () => {
    expect(sanitizeTitle('A   Very\tSpaced   Name')).toBe('A Very Spaced Name')
    expect(sanitizeTitle('B'.repeat(200))!.length).toBeLessThanOrEqual(60)
  })

  it('returns null for empty or quote-only output', () => {
    expect(sanitizeTitle('')).toBeNull()
    expect(sanitizeTitle('\n  \n')).toBeNull()
    expect(sanitizeTitle('""')).toBeNull()
  })
})

describe('dedupeTitle', () => {
  it('returns the title untouched when free', () => {
    expect(dedupeTitle('Sidebar Fix', ['Auth Bug'])).toBe('Sidebar Fix')
  })

  it('suffixes on a case-insensitive collision', () => {
    expect(dedupeTitle('Sidebar Fix', ['sidebar fix'])).toBe('Sidebar Fix 2')
    expect(dedupeTitle('Sidebar Fix', ['Sidebar Fix', 'Sidebar Fix 2'])).toBe('Sidebar Fix 3')
  })
})

describe('configurable naming length', () => {
  it('asks for the configured word range', () => {
    expect(titlePrompt('do a thing', [], { min: 3, max: 8 })).toContain('3-8 words')
  })

  it('says "1 word" rather than "1-1 words" when the range collapses', () => {
    expect(titlePrompt('do a thing', [], { min: 1, max: 1 })).toContain('1 word ')
    expect(titlePrompt('do a thing', [], { min: 1, max: 1 })).not.toContain('1-1')
  })

  it('defaults to 2-5 words when no range is passed', () => {
    expect(titlePrompt('do a thing', [])).toContain('2-5 words')
  })

  it('caps the title at the configured length', () => {
    expect(sanitizeTitle('A'.repeat(200), 20)).toHaveLength(20)
  })

  it('never produces an empty title from a zero cap', () => {
    expect(sanitizeTitle('Something', 0)).toBe('S')
  })
})

describe('title-policy edge cases', () => {
  it('distinguishes a bare fast boot from a full boot in argv and retry plans', () => {
    expect(titleArgs({ extensions: [] })).toEqual([...titleArgs(), '--no-extensions'])
    expect(titleArgs({ extensions: null })).toEqual(titleArgs())
    expect(titleAttempts(CLAUDE_TITLE_FALLBACK, [], { ...CLAUDE_TITLE_FALLBACK })).toEqual([
      { model: CLAUDE_TITLE_FALLBACK, extensions: [] },
      { model: CLAUDE_TITLE_FALLBACK, extensions: null },
    ])
    expect(titleAttempts(null, [], null)).toEqual([
      { model: null, extensions: [] },
      { model: null, extensions: null },
    ])
  })

  it('filters blank names before capping them at forty and truncates the request', () => {
    const prompt = titlePrompt('x'.repeat(1201), [
      ' ',
      ...Array.from({ length: 41 }, (_, i) => `  Title ${i}  `),
    ])
    expect(prompt).toContain('\n- Title 0\n')
    expect(prompt).toContain('\n- Title 39\n')
    expect(prompt).not.toContain('Title 40')
    expect(prompt.split('\nThe request:\n')[1]).toBe('x'.repeat(1200))
    expect(titlePrompt('hi', [], { min: 3, max: 3 })).toContain('3 words ')
  })

  it('strips curly quotes and trims again after capping', () => {
    expect(sanitizeTitle('“Sidebar Fix.”')).toBe('Sidebar Fix')
    expect(sanitizeTitle('One Two', 4)).toBe('One')
    expect(sanitizeTitle('Something', -1)).toBe('S')
  })

  it('trims existing names and returns the original title after all suffixes are taken', () => {
    expect(dedupeTitle('Fix', [' fix ', 'FIX 2'])).toBe('Fix 3')
    expect(
      dedupeTitle('Fix', ['Fix', ...Array.from({ length: 98 }, (_, i) => `Fix ${i + 2}`)]),
    ).toBe('Fix')
  })

  it.each([
    'voxtral',
    'whisper',
    'embed',
    'tts',
    'audio',
    'realtime',
    'guard',
    'moderation',
    'image',
    ':free',
  ])('excludes non-title models containing %s even when priced', (suffix) => {
    const catalogue: TitleCandidate[] = [
      { provider: 'test', id: 'chat-default', cost: { input: 10, output: 10 } },
      { provider: 'test', id: `chat-${suffix}`, cost: { input: 1, output: 1 } },
    ]
    expect(pickTitleModel(catalogue, 'test', 'chat-default')).toBeNull()
  })

  it.each([
    undefined,
    { input: 0, output: 0 },
    { input: -1, output: 0 },
    { input: Infinity, output: 1 },
    { input: NaN, output: 1 },
  ])('rejects unknown or invalid prices %j for both the default and candidates', (cost) => {
    const current = { provider: 'test', id: 'chat-default', cost: { input: 10, output: 10 } }
    const candidate = { provider: 'test', id: 'chat-small', cost }
    expect(pickTitleModel([current, candidate], 'test', current.id)).toBeNull()
    expect(
      pickTitleModel(
        [
          { ...current, cost },
          { ...candidate, cost: current.cost },
        ],
        'test',
        current.id,
      ),
    ).toBeNull()
  })
})
