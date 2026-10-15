import { describe, it, expect } from 'vitest'
import { EXCERPT_MAX, excerptOf } from './lane-excerpt'

describe('excerptOf', () => {
  it('takes the first meaningful line, not a heading marker or rule', () => {
    expect(excerptOf('---\n## Summary\n\nbody')).toBe('Summary')
  })

  it('drops code fences and keeps link text', () => {
    expect(excerptOf('```ts\nconst x = 1\n```\nSee [the docs](https://x.dev).')).toBe(
      'See the docs.',
    )
  })

  it('strips list bullets', () => {
    expect(excerptOf('- first item\n- second')).toBe('first item')
  })

  it('clamps on a word boundary with an ellipsis', () => {
    const long = 'word '.repeat(60)
    const excerpt = excerptOf(long)!
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX)
    expect(excerpt.endsWith('word…')).toBe(true)
  })

  it('returns undefined for nothing to say', () => {
    expect(excerptOf('   \n\n')).toBeUndefined()
  })
})
