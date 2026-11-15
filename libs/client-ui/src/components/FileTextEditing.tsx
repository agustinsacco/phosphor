import { useState } from 'react'
import { Button } from '@/components/form'
import { PlainTextEditor } from '@/components/PlainTextEditor'
import { usePlatform } from '@/platform/Platform'

/**
 * A file's text, edited as this device can. Monaco does not support mobile browsers, so a
 * phone shows `reader` (the file, highlighted) and, while the file is writable, Edit, which
 * swaps in a plain text field over the same buffer; Save sends it as the editor's Mod+S does.
 * Their row is 44px tall, so the buttons' hit-slops stay off the row above.
 * Anywhere else this is `editor`.
 */
export function FileTextEditing({
  id,
  label,
  editor,
  reader,
  value,
  dirty,
  readOnly,
  onChange,
  onSave,
}: {
  /** The file; another one opens on its read view. */
  id: string
  /** The field's accessible name. */
  label: string
  editor: React.ReactNode
  reader: React.ReactNode
  value: string
  dirty: boolean
  readOnly: boolean
  onChange: (value: string) => void
  onSave: () => void
}): React.JSX.Element {
  const phone = usePlatform().formFactor === 'compact'
  const [editing, setEditing] = useState<string | null>(null)
  if (!phone) return <>{editor}</>
  const writing = editing === id && !readOnly
  return (
    <div className="flex h-full min-h-0 flex-col">
      {!readOnly && (
        <div className="border-border flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
          <Button size="sm" onClick={() => setEditing(writing ? null : id)}>
            {writing ? 'Done' : 'Edit'}
          </Button>
          <span className="flex-1" />
          {dirty && (
            <Button size="sm" variant="primary" onClick={onSave}>
              Save
            </Button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {writing ? (
          <PlainTextEditor label={label} value={value} onChange={onChange} onSave={onSave} />
        ) : (
          reader
        )}
      </div>
    </div>
  )
}
