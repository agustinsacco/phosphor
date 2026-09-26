import { describe, expect, it } from 'vitest'
import { allMarkers } from './laneMarker'
import { MARKER_GROUPS, searchMarkers } from './markerCatalog'

describe('marker catalog', () => {
  it('bundles the full catalog with unique glyphs and named categories', () => {
    const all = searchMarkers('')
    expect(all.length).toBeGreaterThan(1900)
    expect(new Set(all.map((marker) => marker.glyph)).size).toBe(all.length)
    for (const group of MARKER_GROUPS) expect(searchMarkers('', group).length).toBeGreaterThan(0)
  })

  it('keeps every original picker choice in Suggested', () => {
    expect(
      searchMarkers('', 'Suggested')
        .map((marker) => marker.glyph)
        .sort(),
    ).toEqual(allMarkers().sort())
  })

  it('searches case-insensitive names, multiple words, and pasted emoji', () => {
    expect(searchMarkers('  FACE grinning ')).toContainEqual(
      expect.objectContaining({ glyph: '😀' }),
    )
    expect(searchMarkers('🛰️')).toContainEqual(expect.objectContaining({ name: 'satellite' }))
    expect(searchMarkers('rocket', 'Travel & Places')).toContainEqual(
      expect.objectContaining({ glyph: '🚀' }),
    )
    expect(searchMarkers('rocket', 'Food & Drink')).toEqual([])
    expect(searchMarkers('not-an-emoji-name')).toEqual([])
  })
})
