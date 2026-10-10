import { describe, expect, it } from 'vitest'
import { directToolsSummary, directToolsText, parseDirectToolsText } from './mcp'

describe('directTools', () => {
  it('summarises what skips the gateway, `true` included', () => {
    expect(directToolsSummary(true)).toBe('all tools')
    expect(directToolsSummary(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('a, b, c, d +2')
    for (const value of [undefined, false, 'search', []])
      expect(directToolsSummary(value)).toBeNull()
  })

  it('round-trips every adapter form through the editor text', () => {
    for (const value of [true, 'search', ['get_issue', 'save_issue']] as const) {
      expect(parseDirectToolsText(directToolsText(value))).toEqual(value)
    }
    expect(parseDirectToolsText('  ')).toBeUndefined()
  })

  it('keeps a lone tool named like a mode a list across an edit', () => {
    for (const value of [['search'], ['all'], ['Search']]) {
      expect(parseDirectToolsText(directToolsText(value))).toEqual(value)
    }
    expect(directToolsText(['search'])).toBe('search,')
  })
})
