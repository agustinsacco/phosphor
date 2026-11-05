import { CheckIcon, ReloadIcon } from '@/components/icons'
import { TooltipButton } from '@/components/Tooltip'
import { IconToggle } from '@/components/IconToggle'
import { CopyToIcon, MoveToIcon, NewEntryIcon, RenameIcon, TrashIcon } from './fileIcons'

export type RemoteFileAction = 'file' | 'directory' | 'rename' | 'delete' | 'copy' | 'move'

const ACTIONS: {
  kind: RemoteFileAction
  title: string
  selection: boolean
  icon: React.ReactNode
}[] = [
  { kind: 'file', title: 'New file', selection: false, icon: <NewEntryIcon kind="file" /> },
  {
    kind: 'directory',
    title: 'New folder',
    selection: false,
    icon: <NewEntryIcon kind="folder" />,
  },
  { kind: 'rename', title: 'Rename', selection: true, icon: <RenameIcon /> },
  { kind: 'delete', title: 'Trash', selection: true, icon: <TrashIcon /> },
  { kind: 'copy', title: 'Copy to folder', selection: true, icon: <CopyToIcon /> },
  { kind: 'move', title: 'Move to folder', selection: true, icon: <MoveToIcon /> },
]

/** The Host Files header: the explorer's glyphs, a read-only tag, and the draft's way out. */
export function RemoteFilesToolbar({
  changes,
  writable,
  busy,
  dirty,
  uncertain,
  editable,
  selected,
  onRefresh,
  onAction,
  onSave,
  onDiscard,
}: {
  changes: boolean
  writable: boolean
  busy: boolean
  dirty: boolean
  uncertain: boolean
  editable: boolean
  selected: string | null
  onRefresh: () => void
  onAction: (kind: RemoteFileAction) => void
  onSave: () => void
  onDiscard: () => void
}): React.JSX.Element {
  return (
    <div className="border-border flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1">
      <span className="text-text-tertiary mr-auto text-xs font-semibold font-mono uppercase tracking-wider">
        {changes ? 'Changes' : 'Explorer'}
      </span>
      {!writable && (
        <span className="bg-bg-secondary text-text-secondary rounded-full px-1.5 py-0.5 text-2xs font-medium">
          Read only
        </span>
      )}
      <IconToggle title="Refresh" onClick={onRefresh}>
        <ReloadIcon />
      </IconToggle>
      {writable && !changes && (
        <>
          {ACTIONS.map(({ kind, title, selection, icon }) => (
            <IconToggle
              key={kind}
              title={title}
              disabled={busy || dirty || (selection && !selected)}
              onClick={() => onAction(kind)}
            >
              {icon}
            </IconToggle>
          ))}
          <IconToggle
            title="Save"
            disabled={busy || uncertain || !dirty || !editable}
            onClick={onSave}
          >
            <CheckIcon />
          </IconToggle>
        </>
      )}
      {dirty && (
        <TooltipButton
          className="text-accent rounded-sm px-2 py-1 text-sm hover:bg-bg-secondary"
          disabled={busy}
          onClick={onDiscard}
        >
          {uncertain ? 'Reload file' : 'Discard edits'}
        </TooltipButton>
      )}
    </div>
  )
}
