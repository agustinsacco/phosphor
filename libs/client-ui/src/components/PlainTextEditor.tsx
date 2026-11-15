import { useRef } from 'react'
import { dominantLineEnding, withLineEnding, type LineEnding } from '@/lib/lineEndings'

/**
 * Text editing where a code editor cannot run (Monaco does not support mobile browsers):
 * a monospace field at 16px, so iOS does not zoom on focus, with the corrections a
 * keyboard makes to prose turned off. Mod+S saves, for a tablet's keyboard.
 *
 * A textarea holds LF only: it reads CRLF and a lone CR as LF. Each edit goes back in the
 * line ending the text had before it, as Monaco keeps its model's, so one typed character
 * does not rewrite every line of a CRLF file. Text with no line break keeps the last ending
 * seen, and starts as LF.
 */
export function PlainTextEditor({
  label,
  value,
  readOnly = false,
  onChange,
  onSave,
}: {
  label: string
  value: string
  readOnly?: boolean
  onChange: (value: string) => void
  onSave?: () => void
}): React.JSX.Element {
  const ending = useRef<LineEnding>('\n')
  return (
    <textarea
      aria-label={label}
      value={withLineEnding(value, '\n')}
      readOnly={readOnly}
      onChange={(event) => {
        ending.current = dominantLineEnding(value) ?? ending.current
        onChange(withLineEnding(event.target.value, ending.current))
      }}
      onKeyDown={(event) => {
        if (!onSave || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
        event.preventDefault()
        onSave()
      }}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      autoComplete="off"
      className="bg-surface text-text h-full w-full resize-none p-3 font-mono text-[16px] leading-relaxed outline-none"
    />
  )
}
