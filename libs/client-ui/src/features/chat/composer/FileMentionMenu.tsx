import type { LaneMention } from './laneMentions'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'

export function FileMentionMenu({
  files,
  lanes,
  activeIndex,
  onHover,
  onPick,
  onClose,
}: {
  lanes: LaneMention[]
  files: string[]
  activeIndex: number
  onHover: (index: number) => void
  onPick: (item: string | LaneMention) => void
  onClose: () => void
}): React.JSX.Element | null {
  if (!files.length && !lanes.length) return null

  return (
    <PopupMenu
      onClose={onClose}
      className="absolute bottom-full left-0 mb-2 max-h-72 w-[26rem] max-w-[calc(100vw-16rem)] overflow-y-auto py-1.5"
      fitViewport
    >
      {files.map((file, index) => {
        const slash = file.lastIndexOf('/')
        const dir = slash === -1 ? '' : file.slice(0, slash + 1)
        const base = slash === -1 ? file : file.slice(slash + 1)
        return (
          <MenuRow
            key={file}
            active={index === activeIndex}
            onHover={() => onHover(index)}
            onClick={() => onPick(file)}
          >
            <FileIcon />
            <span className="min-w-0 flex-1 truncate font-mono text-base">
              {dir && <span className="text-text-tertiary">{dir}</span>}
              <span className="text-text">{base}</span>
            </span>
          </MenuRow>
        )
      })}
      {lanes.length > 0 && <div className="text-text-tertiary px-3 pt-1 text-sm">Lanes</div>}
      {lanes.map((lane, i) => (
        <MenuRow
          key={lane.href}
          active={files.length + i === activeIndex}
          onHover={() => onHover(files.length + i)}
          onClick={() => onPick(lane)}
        >
          <span className="flex-1 truncate">{lane.title}</span>
          <span className="text-text-tertiary truncate text-sm">{lane.machine}</span>
        </MenuRow>
      ))}
    </PopupMenu>
  )
}

function FileIcon(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="text-text-tertiary shrink-0"
    >
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}
