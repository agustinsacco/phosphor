import { useMemo } from 'react'
import type { RpcSlashCommand } from '@shared/rpc'
import { fuzzyFilter } from '@/lib/fuzzy'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'

export interface NativeCommand {
  name: string
  description: string
  run: () => void
}

export interface CommandEntry {
  name: string
  description?: string
  badge: 'phosphor' | 'extension' | 'prompt' | 'skill'
  native?: NativeCommand
}

export function buildCommandEntries(
  piCommands: readonly RpcSlashCommand[],
  nativeCommands: readonly NativeCommand[],
): CommandEntry[] {
  const native: CommandEntry[] = nativeCommands.map((command) => ({
    name: command.name,
    description: command.description,
    badge: 'phosphor',
    native: command,
  }))
  const fromPi: CommandEntry[] = piCommands.map((command) => ({
    name: command.name,
    description: command.description,
    badge: command.source,
  }))
  return [...native, ...fromPi]
}

const BADGE_STYLES: Record<CommandEntry['badge'], string> = {
  phosphor: 'bg-accent-soft text-accent',
  extension: 'bg-info/10 text-info',
  prompt: 'bg-success/10 text-success',
  skill: 'bg-warning/10 text-warning',
}

export function CommandMenu({
  query,
  entries,
  activeIndex,
  onHover,
  onPick,
  onClose,
}: {
  query: string
  entries: CommandEntry[]
  activeIndex: number
  onHover: (index: number) => void
  onPick: (entry: CommandEntry) => void
  onClose: () => void
}): React.JSX.Element | null {
  const filtered = useMemo(() => fuzzyFilter(query, entries, (e) => e.name, 12), [query, entries])
  if (filtered.length === 0) return null

  return (
    <PopupMenu
      onClose={onClose}
      className="absolute bottom-full left-0 mb-2 max-h-72 w-[26rem] max-w-[calc(100vw-16rem)] overflow-y-auto py-1.5"
      fitViewport
    >
      {filtered.map((entry, index) => (
        <MenuRow
          key={`${entry.badge}-${entry.name}`}
          active={index === activeIndex}
          onHover={() => onHover(index)}
          onClick={() => onPick(entry)}
        >
          <span className="font-mono text-base font-medium">/{entry.name}</span>
          <span className="text-text-tertiary flex-1 truncate text-base">
            {entry.description ?? ''}
          </span>
          <span
            className={`shrink-0 rounded px-1.5 py-px text-2xs font-semibold font-mono uppercase tracking-wide ${BADGE_STYLES[entry.badge]}`}
          >
            {entry.badge}
          </span>
        </MenuRow>
      ))}
    </PopupMenu>
  )
}

/** Filtered view used by the composer for keyboard navigation. */
export function filterCommandEntries(query: string, entries: CommandEntry[]): CommandEntry[] {
  return fuzzyFilter(query, entries, (e) => e.name, 12)
}
