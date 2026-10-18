import { describe, expect, it } from 'vitest'
import * as desktop from '../../../../apps/desktop/electron/pi/session-naming'
import * as host from '../../../../apps/host/src/lanes/title-policy'

// This cross-app freeze deliberately exercises the original public entries.
const entries = [
  ['Desktop session-naming', desktop],
  ['Host title-policy', host],
] as const
const model = { provider: 'pi-claude-cli', id: 'claude-haiku-5-5' }
const fallback = { provider: 'pi-claude-cli', id: 'claude-haiku-4-5' }
const baseArgs = [
  '-p',
  '--no-session',
  '--no-tools',
  '--no-context-files',
  '--no-skills',
  '--no-prompt-templates',
  '--thinking',
  'off',
]
const promptStart =
  'You name coding sessions. Reply with ONLY the name: a short capitalized phrase of '
const promptRule = 'summarizing the request below. No quotes, no trailing period, no explanation.\n'

const attemptCases = [
  {
    name: 'ordered fast boot, full boot, fallback',
    model,
    extensions: ['/provider.ts'],
    fallback,
    expected: [
      { model, extensions: ['/provider.ts'] },
      { model, extensions: null },
      { model: fallback, extensions: null },
    ],
  },
  {
    name: 'empty extension list still means fast boot',
    model,
    extensions: [],
    fallback: null,
    expected: [
      { model, extensions: [] },
      { model, extensions: null },
      { model: null, extensions: null },
    ],
  },
  {
    name: 'null extension list omits fast boot',
    model,
    extensions: null,
    fallback,
    expected: [
      { model, extensions: null },
      { model: fallback, extensions: null },
    ],
  },
  {
    name: 'equal model values deduplicate full boots',
    model,
    extensions: [],
    fallback: { ...model },
    expected: [
      { model, extensions: [] },
      { model, extensions: null },
    ],
  },
  {
    name: 'all defaults collapse to a single full boot',
    model: null,
    extensions: null,
    fallback: null,
    expected: [{ model: null, extensions: null }],
  },
]

describe.each(entries)('%s characterization', (_name, policy) => {
  it('pins fallback identity and exact argv, including empty versus null extensions', () => {
    expect(policy.CLAUDE_TITLE_FALLBACK).toEqual(fallback)
    expect(policy.titleArgs()).toEqual(baseArgs)
    expect(policy.titleArgs({ model: null, extensions: null })).toEqual(baseArgs)
    expect(policy.titleArgs({ extensions: [] })).toEqual([...baseArgs, '--no-extensions'])
    expect(policy.titleArgs({ model, extensions: ['/provider.ts', '/other.ts'] })).toEqual([
      ...baseArgs,
      '--provider',
      model.provider,
      '--model',
      model.id,
      '--no-extensions',
      '-e',
      '/provider.ts',
      '-e',
      '/other.ts',
    ])
  })

  it.each(attemptCases)('pins retry planning: $name', (testCase) => {
    expect(policy.titleAttempts(testCase.model, testCase.extensions, testCase.fallback)).toEqual(
      testCase.expected,
    )
  })

  it('pins exact prompts, word-range grammar, and trimmed names', () => {
    expect(policy.titlePrompt('fix sidebar', [])).toBe(
      promptStart + '2-5 words ' + promptRule + '\nThe request:\nfix sidebar',
    )
    expect(policy.titlePrompt('fix sidebar', ['  Auth Bug  ', ' '], { min: 1, max: 1 })).toBe(
      promptStart +
        '1 word ' +
        promptRule +
        '\nExisting session names in this workspace (yours must not duplicate or be easily confused with any of them):\n- Auth Bug\n' +
        '\nThe request:\nfix sidebar',
    )
    expect(policy.titlePrompt('hi', ['  '], { min: 3, max: 3 })).toBe(
      promptStart + '3 words ' + promptRule + '\nThe request:\nhi',
    )
  })

  it('pins message and existing-name caps', () => {
    const names = Array.from({ length: 45 }, (_, i) => `Name ${i}`)
    const prompt = policy.titlePrompt('x'.repeat(1201), [' ', ...names])
    expect(prompt).toBe(
      promptStart +
        '2-5 words ' +
        promptRule +
        '\nExisting session names in this workspace (yours must not duplicate or be easily confused with any of them):\n' +
        names
          .slice(0, 40)
          .map((name) => `- ${name}`)
          .join('\n') +
        '\n\nThe request:\n' +
        'x'.repeat(1200),
    )
  })

  it.each([
    ['Here is the name:\n\n“Sidebar   Resize Fix.”\n', 60, 'Sidebar Resize Fix'],
    ['\n\t', 60, null],
    ['""', 60, null],
    ['A'.repeat(61), 60, 'A'.repeat(60)],
    ['Something', 0, 'S'],
    ['One Two', 4, 'One'],
  ] as const)('sanitizes %j with cap %s', (stdout, cap, expected) => {
    expect(policy.sanitizeTitle(stdout, cap)).toBe(expected)
  })

  it('pins case-insensitive duplicate suffix order and exhaustion', () => {
    expect(policy.dedupeTitle('Sidebar Fix', ['Other'])).toBe('Sidebar Fix')
    expect(policy.dedupeTitle('Sidebar Fix', [' sidebar fix ', 'SIDEBAR FIX 2'])).toBe(
      'Sidebar Fix 3',
    )
    const taken = ['Sidebar Fix', ...Array.from({ length: 98 }, (_, i) => `Sidebar Fix ${i + 2}`)]
    expect(policy.dedupeTitle('Sidebar Fix', taken)).toBe('Sidebar Fix')
  })
})
