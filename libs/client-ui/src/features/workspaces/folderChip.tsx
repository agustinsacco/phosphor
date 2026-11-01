/**
 * The composer's folder chip, shared by This Mac's `WorkspaceChip` and a Host's
 * repository picker, so "where this lane runs" looks the same on every machine.
 */
export const FOLDER_CHIP = 'border-border rounded-lg border px-2.5 py-1 text-base font-medium'
export const FOLDER_CHIP_IDLE =
  'bg-surface text-text-secondary hover:text-text hover:border-border-strong'
/** The chip closed, as a complete trigger class. */
export const FOLDER_CHIP_CLASS = `flex cursor-pointer items-center gap-1.5 transition-colors ${FOLDER_CHIP} ${FOLDER_CHIP_IDLE}`

export function FolderIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="shrink-0"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}
