import { useState } from 'react'
import { tooltipProps } from '@/components/Tooltip'
import { checkDuration, checkNote, type CheckGroups, type InspectorCheck } from './checkGroups'
import { LinkButton, Tag } from './PrBits'
import { CHECK_GLYPH, PrGlyph } from './PrIcons'
import { useNow } from './PrHeader'

function CheckRow({
  check,
  now,
  onOpen,
}: {
  check: InspectorCheck
  now: number
  onOpen: (url: string) => void
}): React.JSX.Element {
  const [glyph, tone] = CHECK_GLYPH[check.state]
  const note = checkNote(check)
  const duration = checkDuration(check, now)
  const log = (check.state === 'failure' || check.state === 'pending') && check.url
  return (
    <li data-testid="pr-check" data-state={check.state} className="px-1 py-1 text-base">
      <div className="flex min-w-0 items-center gap-1.5">
        <PrGlyph glyph={glyph} size={13} className={tone} />
        <span className="min-w-0 flex-1 truncate" {...tooltipProps(check.name)}>
          {check.name}
        </span>
        {check.required && <Tag strong>required</Tag>}
        {check.workflow && check.workflow !== check.name && (
          <span className="max-w-[35%] min-w-0 truncate">
            <Tag>{check.workflow}</Tag>
          </span>
        )}
        {duration && (
          <span className="text-text-tertiary shrink-0 text-sm tabular-nums">{duration}</span>
        )}
        {log && (
          <LinkButton
            onClick={() => onOpen(check.url!)}
            label={`Open the ${check.name} log on GitHub`}
          >
            log ↗
          </LinkButton>
        )}
      </div>
      {note && (
        <p className="text-text-secondary truncate pl-[19px] text-sm" {...tooltipProps(note)}>
          {note}
        </p>
      )}
    </li>
  )
}

/** Failing, running and required checks, then "+N passing" for the rest; skipped on one line. */
export function CheckList({
  groups,
  onOpen,
}: {
  groups: CheckGroups
  onOpen: (url: string) => void
}): React.JSX.Element {
  const now = useNow()
  const [all, setAll] = useState(false)
  const showRest = all || !groups.lead.length
  const rows = showRest ? [...groups.lead, ...groups.rest] : groups.lead
  const skipped = groups.skipped.map((c) => c.name).join(', ')
  return (
    <div>
      <ul>
        {rows.map((check, i) => (
          <CheckRow key={`${check.name}:${i}`} check={check} now={now} onOpen={onOpen} />
        ))}
      </ul>
      {groups.lead.length > 0 && groups.rest.length > 0 && (
        <div className="px-1 py-1">
          <LinkButton onClick={() => setAll(!all)} expanded={all}>
            {all ? 'Show fewer' : `+${groups.rest.length} passing`}
          </LinkButton>
        </div>
      )}
      {groups.skipped.length > 0 && (
        <p className="text-text-tertiary flex min-w-0 items-center gap-1.5 px-1 py-1 text-sm">
          <PrGlyph glyph="skip" size={13} />
          <span className="truncate" {...tooltipProps(skipped)}>
            {groups.skipped.length} skipped: {skipped}
          </span>
        </p>
      )}
    </div>
  )
}

export function PrChecksTab({
  groups,
  loading,
  onOpen,
}: {
  groups: CheckGroups
  loading: boolean
  onOpen: (url: string) => void
}): React.JSX.Element {
  if (!groups.known)
    return (
      <p className="text-text-secondary text-base">
        {loading
          ? 'Reading checks…'
          : 'GitHub did not list this pull request’s checks. Open it on GitHub to see them.'}
      </p>
    )
  if (!groups.counts.total)
    return <p className="text-text-secondary text-base">No checks reported.</p>
  return (
    <>
      {groups.truncated && (
        <p
          role="note"
          className="border-warning/40 bg-warning/10 text-text mb-2 flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm"
        >
          <PrGlyph glyph="alert" size={13} className="text-warning" />
          Over 100 checks: this list is partial, so it cannot say everything passed.
        </p>
      )}
      <CheckList groups={groups} onOpen={onOpen} />
    </>
  )
}
