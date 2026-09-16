import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import {
  BADGE_LABELS,
  entryTooltip,
  type CommandBadge,
  type CommandEntry,
} from './commandCatalogue'

export {
  buildCommandEntries,
  filterCommandEntries,
  type CommandEntry,
  type NativeCommand,
} from './commandCatalogue'

/** What the list is doing when it has nothing to show yet. */
export type CommandMenuStatus = 'idle' | 'loading' | 'ready' | 'error'

const BADGE_STYLES: Record<CommandBadge, string> = {
  phosphor: 'bg-accent-soft text-accent',
  extension: 'bg-info/10 text-info',
  prompt: 'bg-success/10 text-success',
  skill: 'bg-warning/10 text-warning',
}

/** DOM id for one option, so the textarea can point at it via aria-activedescendant. */
export const commandOptionId = (listboxId: string, index: number): string =>
  `${listboxId}-option-${index}`

/**
 * The `/` popup. Renders exactly the `entries` it is given, in that order —
 * filtering and ranking happen once, in `useSlashMenu`, so the row the user
 * sees highlighted is the same array element Enter will pick. (It used to
 * re-filter here with its own copy of the limit, and the two only agreed
 * because both hardcoded `12`.)
 *
 * Section headers appear only while browsing (empty query): a ranked result
 * list is one flat list. Headers are not rows — they are not in `entries`, so
 * the keymap's indices are untouched by them.
 */
export function CommandMenu({
  query,
  entries,
  activeIndex,
  status = 'ready',
  errorMessage,
  listboxId = 'composer-command-menu',
  onHover,
  onPick,
  onClose,
}: {
  query: string
  entries: CommandEntry[]
  activeIndex: number
  status?: CommandMenuStatus
  errorMessage?: string
  listboxId?: string
  onHover: (index: number) => void
  onPick: (entry: CommandEntry) => void
  onClose: () => void
}): React.JSX.Element {
  const browsing = query === ''

  return (
    <PopupMenu
      onClose={onClose}
      className="absolute bottom-full left-0 mb-2 max-h-72 w-[30rem] max-w-[calc(100vw-16rem)] overflow-y-auto py-1.5"
      fitViewport
      role="listbox"
      id={listboxId}
      ariaLabel="Slash commands"
      ariaActiveDescendant={
        entries.length > 0 ? commandOptionId(listboxId, activeIndex) : undefined
      }
    >
      {entries.length === 0 && (
        <EmptyRow query={query} status={status} errorMessage={errorMessage} />
      )}
      {entries.map((entry, index) => {
        const header = browsing && (index === 0 || entries[index - 1]!.badge !== entry.badge)
        return (
          <div key={`${entry.badge}-${entry.name}`}>
            {header && (
              <div
                role="presentation"
                className={`text-text-tertiary px-3 pb-0.5 text-2xs font-semibold uppercase tracking-wide ${
                  index === 0 ? 'pt-0.5' : 'border-border/60 mt-1 border-t pt-1.5'
                }`}
              >
                {BADGE_LABELS[entry.badge]}
              </div>
            )}
            <MenuRow
              id={commandOptionId(listboxId, index)}
              role="option"
              ariaSelected={index === activeIndex}
              active={index === activeIndex}
              onHover={() => onHover(index)}
              onClick={() => onPick(entry)}
              title={entryTooltip(entry)}
              testId="command-menu-row"
            >
              <span className="shrink-0 font-mono text-base font-medium">/{entry.name}</span>
              <span className="text-text-tertiary min-w-0 flex-1 truncate text-base">
                {entry.description ?? ''}
              </span>
              <span className="text-text-tertiary max-w-[10rem] shrink-0 truncate font-mono text-2xs">
                {entry.origin}
              </span>
              <span
                className={`shrink-0 rounded px-1.5 py-px text-2xs font-semibold font-mono uppercase tracking-wide ${BADGE_STYLES[entry.badge]}`}
              >
                {entry.badge}
              </span>
            </MenuRow>
          </div>
        )
      })}
    </PopupMenu>
  )
}

/**
 * The one row shown when there is nothing to list. Says which of the four
 * reasons applies — the menu used to vanish for all of them, which read as
 * "the menu is broken" for a list that was merely still loading.
 */
function EmptyRow({
  query,
  status,
  errorMessage,
}: {
  query: string
  status: CommandMenuStatus
  errorMessage?: string
}): React.JSX.Element {
  let text: string
  if (status === 'loading') text = 'Loading commands…'
  else if (status === 'error') {
    text = `Couldn't list commands${errorMessage ? ` — ${errorMessage}` : ''}`
  } else if (query) {
    text = `No command matches /${query} — Enter sends it to pi as a prompt`
  } else text = 'No commands available'
  return (
    <div
      role="presentation"
      data-testid="command-menu-empty"
      className={`px-3 py-1.5 text-base ${status === 'error' ? 'text-danger' : 'text-text-tertiary'}`}
    >
      {text}
    </div>
  )
}
