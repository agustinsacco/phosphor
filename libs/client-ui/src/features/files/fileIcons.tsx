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

export const RenameIcon = (): React.JSX.Element => (
  <Glyph d={['M4 20h4L19 9l-4-4L4 16z', 'm13 7 4 4']} />
)
export const TrashIcon = (): React.JSX.Element => (
  <Glyph d={['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13']} />
)
export const CopyToIcon = (): React.JSX.Element => <Glyph d={['M8 8h12v12H8z', 'M4 16V4h12']} />
export const MoveToIcon = (): React.JSX.Element => (
  <Glyph d={['M3 20V4h7l3 3h8v13H3', 'M9 13h7', 'm13 10 3 3-3 3']} />
)
