import { describe, expect, it } from 'vitest'
import {
  formatSeconds,
  thoughtDuration,
  thoughtHeadline,
  thoughtLabel,
  thoughtTail,
} from './thoughts'

describe('thoughtHeadline', () => {
  // The shape Codex reasoning summaries take in pi sessions.
  const codex =
    '**Fetching skills tables**\n\nI need the tables first.\n\n**Evaluating standard-library parsing**\n\nMaybe json is enough.'

  it('uses a Codex section title: the first for a settled row, the newest for a live line', () => {
    expect(thoughtHeadline(codex, 'first')).toBe('Fetching skills tables')
    expect(thoughtHeadline(codex, 'latest')).toBe('Evaluating standard-library parsing')
  })

  it('uses the first sentence of a paragraph for prose, as Claude writes it', () => {
    const prose =
      'The user wants the port. I should read the config first.\n\nThe config sets 8080. So the answer is 8080.'
    expect(thoughtHeadline(prose, 'first')).toBe('The user wants the port.')
    expect(thoughtHeadline(prose, 'latest')).toBe('The config sets 8080.')
  })

  it('does not end a sentence inside a version number or a file name', () => {
    expect(
      thoughtHeadline('Claude Code 2.1.283 reads config.json at start. Then more.', 'first'),
    ).toBe('Claude Code 2.1.283 reads config.json at start.')
  })

  it('strips markdown, so a headline never shows syntax', () => {
    expect(thoughtHeadline('## Plan\n\nMore', 'first')).toBe('Plan')
    expect(thoughtHeadline('Read `src/app.ts` and [the docs](https://x.y) first.', 'first')).toBe(
      'Read src/app.ts and the docs first.',
    )
    // Bold that is not a whole-line title is just emphasis.
    expect(thoughtHeadline('**Note**: the file is big. Next.', 'first')).toBe(
      'Note: the file is big.',
    )
  })

  it('caps a very long headline', () => {
    const headline = thoughtHeadline('word '.repeat(100), 'first')!
    expect(headline.length).toBeLessThanOrEqual(160)
    expect(headline.endsWith('…')).toBe(true)
  })

  it('has no headline for a thought with no text', () => {
    expect(thoughtHeadline('', 'latest')).toBeUndefined()
    expect(thoughtHeadline('  \n\n  ', 'first')).toBeUndefined()
  })
})

describe('thoughtTail', () => {
  it('is the newest sentence, never a title', () => {
    expect(thoughtTail('**Planning**\n\nOne edit. Then the `tests`.')).toBe('Then the tests.')
    expect(thoughtTail('The port is 8080. I will say so')).toBe('I will say so')
  })

  it('has none while a new section has only its title', () => {
    expect(thoughtTail('**Reading**\n\nDone reading.\n\n**Planning the change**')).toBeUndefined()
    expect(thoughtTail('')).toBeUndefined()
  })
})

describe('thoughtDuration', () => {
  it('sums the blocks one thought joins', () => {
    expect(
      thoughtDuration(
        [
          { startedAt: 0, endedAt: 2_000 },
          { startedAt: 5_000, endedAt: 6_000 },
        ],
        9_999,
      ),
    ).toBe(3_000)
  })

  it('counts a block that is still streaming up to now', () => {
    expect(thoughtDuration([{ startedAt: 1_000 }], 4_000)).toBe(3_000)
  })

  it('is unknown when any block has no timing, rather than undercounting', () => {
    expect(thoughtDuration([{ startedAt: 0, endedAt: 1_000 }, {}], 5_000)).toBeUndefined()
    expect(thoughtDuration([], 5_000)).toBeUndefined()
  })
})

describe('labels', () => {
  it('reads in whole seconds, then minutes', () => {
    expect(formatSeconds(0)).toBe('1s')
    expect(formatSeconds(12_400)).toBe('12s')
    expect(formatSeconds(60_000)).toBe('1m')
    expect(formatSeconds(75_000)).toBe('1m 15s')
  })

  it('says how long when it knows, and only "Thought" when it does not', () => {
    expect(thoughtLabel(12_000)).toBe('Thought for 12s')
    expect(thoughtLabel(undefined)).toBe('Thought')
  })
})
