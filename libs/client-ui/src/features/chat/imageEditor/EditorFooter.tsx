import { TooltipLabel } from '@/components/Tooltip'
import { Button } from '@/components/form'
import { formatShortcut } from '@/lib/shortcuts'

export function EditorFooter({
  discardArmed,
  onKeep,
  onDiscard,
  replace,
  onReplace,
  onCancel,
  onDone,
  ready,
  saving,
}: {
  discardArmed: boolean
  onKeep: () => void
  onDiscard: () => void
  replace: boolean
  onReplace: (replace: boolean) => void
  onCancel: () => void
  onDone: () => void
  ready: boolean
  saving: boolean
}): React.JSX.Element {
  return (
    <div className="image-editor-footer border-border flex flex-wrap items-center gap-3 border-t px-4 py-2.5">
      {discardArmed ? (
        <>
          <span className="text-text mr-auto text-base">Discard your annotations?</span>
          <Button size="sm" onClick={onKeep}>
            Keep editing
          </Button>
          <Button size="sm" variant="danger" onClick={onDiscard}>
            Discard
          </Button>
        </>
      ) : (
        <>
          <span className="image-editor-help text-text-tertiary mr-auto text-sm">
            Hold Shift for a square or circle · {formatShortcut('mod', 'V')} pastes an image on top
            · Esc closes
          </span>
          <TooltipLabel
            className="text-text-secondary flex cursor-pointer items-center gap-2 text-base"
            data-tooltip={
              replace
                ? 'The annotated image takes the original’s place'
                : 'Keeps the original and adds the annotated copy next to it'
            }
          >
            <input
              type="checkbox"
              checked={replace}
              onChange={(event) => onReplace(event.target.checked)}
            />
            Replace original
          </TooltipLabel>
          <Button size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!ready || saving} onClick={onDone}>
            {saving ? 'Saving…' : 'Done'}
          </Button>
        </>
      )}
    </div>
  )
}
