import { strokeProps } from '@/components/icons'

/** Stroke glyphs for file toolbars, drawn at the explorer's 12–13 px. */
function Glyph({ size = 12, d }: { size?: number; d: string[] }): React.JSX.Element {
  return (
    <svg {...strokeProps(size)}>
      {d.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  )
}

/** The explorer's New file / New folder glyph: the entry's outline with a plus. */
export function NewEntryIcon({ kind }: { kind: 'file' | 'folder' }): React.JSX.Element {
  return (
    <Glyph
      size={13}
      d={[kind === 'file' ? 'M14 2H4v20h16V8l-6-6v6h6' : 'M3 20V4h7l3 3h8v13H3', 'M8 14h8m-4-4v8']}
    />
  )
}
