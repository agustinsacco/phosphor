import { describe, expect, it } from 'vitest'
import { sessionTitle } from './sessionTitle'

describe('sessionTitle', () => {
  it('prefers an explicit name', () => {
    expect(sessionTitle({ explicitName: 'my-feature', firstUserText: 'do the thing' })).toBe(
      'my-feature',
    )
  })

  it('falls back to the first prompt when pi never named the session', () => {
    // pi only sets sessionName via set_session_name / --name, so this is the
    // common case for an ordinary chat — the header used to say "New session"
    // for the entire conversation.
    expect(sessionTitle({ explicitName: undefined, firstUserText: 'fix the artifact pane' })).toBe(
      'fix the artifact pane',
    )
    expect(sessionTitle({ explicitName: null, firstUserText: 'hello' })).toBe('hello')
  })

  it('ignores whitespace-only sources', () => {
    expect(sessionTitle({ explicitName: '   ', firstUserText: '\n\n' })).toBeNull()
    expect(sessionTitle({ explicitName: '  ', firstUserText: 'real' })).toBe('real')
  })

  it('returns null when nothing is known', () => {
    expect(sessionTitle({})).toBeNull()
  })

  it('uses the first non-empty line of a multi-line prompt', () => {
    expect(sessionTitle({ firstUserText: '\n\nreview these fixes:\n1. one\n2. two' })).toBe(
      'review these fixes:',
    )
  })

  it('elides long titles at 80 chars', () => {
    const title = sessionTitle({ firstUserText: 'x'.repeat(200) })!
    expect(title).toHaveLength(80)
    expect(title.endsWith('…')).toBe(true)
  })

  it('preserves full titles for CSS-clamped rows, tooltips and search', () => {
    const name = 'x'.repeat(100) + ' searchable suffix'
    expect(sessionTitle({ explicitName: name }, { elide: false })).toBe(name)
    expect(sessionTitle({ firstUserText: `\n${name}\nnot the title` }, { elide: false })).toBe(name)
    expect(sessionTitle({}, { elide: false })).toBeNull()
  })

  it('does not elide an explicit name that fits', () => {
    const name = 'a'.repeat(80)
    expect(sessionTitle({ explicitName: name })).toBe(name)
  })

  it('never splits an astral character at the elision boundary', () => {
    // 79 chars then an emoji spanning the cut point: a UTF-16 slice would
    // leave a lone surrogate (mojibake) right before the ellipsis.
    const title = sessionTitle({ firstUserText: 'x'.repeat(79) + '🎨🎨🎨' })!
    expect(title.endsWith('…')).toBe(true)
    expect(title).not.toMatch(/[\uD800-\uDBFF]…$/)
    // Round-trippable: every code point in the output is whole.
    expect([...title].join('')).toBe(title)
  })
})
