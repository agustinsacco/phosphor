/**
 * Text editing where a code editor cannot run (Monaco does not support mobile browsers):
 * a monospace field at 16px, so iOS does not zoom on focus, with the corrections a
 * keyboard makes to prose turned off. Mod+S saves, for a tablet's keyboard.
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
  return (
    <textarea
      aria-label={label}
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
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
