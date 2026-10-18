import groups from 'unicode-emoji-json/data-by-group.json'
import { allMarkers } from './laneMarker'

/** Bundled Unicode catalog: native glyphs, no image CDN or network requests. */
export const MARKER_GROUPS = ['Suggested', ...groups.map((group) => group.name)]
const suggested = new Set(allMarkers())
const markers = groups.flatMap((group) =>
  group.emojis.map(({ emoji, name }) => ({ glyph: emoji, name, group: group.name })),
)

export function searchMarkers(query: string, group = ''): typeof markers {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return markers.filter(
    (marker) =>
      (!group || (group === 'Suggested' ? suggested.has(marker.glyph) : marker.group === group)) &&
      words.every((word) =>
        `${marker.name} ${marker.group} ${marker.glyph}`.toLowerCase().includes(word),
      ),
  )
}
