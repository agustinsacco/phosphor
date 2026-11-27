import clsx from 'clsx'
import { useState } from 'react'
import { committedRename } from './inlineRename'
import type { NameTransition } from './nameTransition'
import { RenameInput } from './RenameInput'
import { SESSION_TITLE_CLASS } from './SidebarPrimitives'

/**
 * Every lane row's body, This Mac's saved and pending rows and a Host's alike:
 * indicator, marker, the title over its subtitle line, then trailing badges.
 * Each row fills the slots from its own data; none is built from another's.
 *
 * A function, not a component: the row's button derives its accessible name
 * from the intrinsic elements among its children (`actionLabel`), so the body
 * must arrive as plain markup.
 */
export function laneRowBody({
  indicator,
  marker,
  title,
  subtitleClassName,
  subtitle,
  trailing,
}: {
  indicator: React.ReactNode
  /** Absent when markers are off. */
  marker?: React.ReactNode
  /** The title, or the rename field while editing. */
  title: React.ReactNode
  subtitleClassName: string
  subtitle: React.ReactNode
  trailing?: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      {indicator}
      {marker}
      <span className="min-w-0 flex-1">
        {title}
        <span className={subtitleClassName}>{subtitle}</span>
      </span>
      {trailing}
    </>
  )
}

/**
 * A This Mac lane's title, as plain markup like `laneRowBody`. The saved and pending rows share it because a live
 * lane swaps from one to the other mid-turn, and any difference reads as a
 * twitch.
 */
export function localLaneTitle(title: string, naming: NameTransition): React.JSX.Element {
  return (
    <span
      // Re-keyed on the title so the arrival of a generated name replays the
      // entrance; without it React patches the text node in place and the
      // name simply pops.
      key={title}
      data-tooltip={naming.pending ? 'Naming this chat…' : title}
      data-testid="session-title"
      className={clsx(
        SESSION_TITLE_CLASS,
        // Shimmers while pending, same as the top bar (.name-pending in
        // index.css): a session you just created is watched here at least as
        // often as in the top bar, and a name sitting still read as settled
        // rather than still in flight. The branch chip in BranchControl stays
        // arrival-only: that combo (this row, the top bar, the chip, all three
        // at once) is what previously made starting a chat read as busy.
        naming.pending && 'name-pending',
        naming.settled && 'name-enter',
      )}
    >
      {title}
    </span>
  )
}

/**
 * A lane row's inline rename: `begin` opens the field on the current title,
 * and committing closes it and saves only what `committedRename` accepts.
 * `editor` is the field while editing, else undefined.
 */
export function useInlineRename(
  title: string,
  save: (name: string) => void,
  field: { maxLength?: number; label?: string } = {},
): { editing: boolean; begin: () => void; editor: React.ReactNode } {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    const name = draft === null ? undefined : committedRename(draft, title)
    setDraft(null)
    if (name) save(name)
  }
  return {
    editing: draft !== null,
    begin: () => setDraft(title),
    editor:
      draft === null ? undefined : (
        <RenameInput
          value={draft}
          onChange={setDraft}
          onCommit={commit}
          onCancel={() => setDraft(null)}
          {...field}
        />
      ),
  }
}
