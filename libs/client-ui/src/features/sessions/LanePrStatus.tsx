import { useEffect, useRef, useState } from 'react'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { usePrInspectorStore } from '@/stores/prInspector'
import { useLanePullRequests } from './useLanePrs'
import type { LanePr, LanePrs } from './lanePrs'
import { LaneHeaderPill } from './LaneHeaderPill'
import { LanePrInspector, type InspectorLane } from './pr-inspector/LanePrInspector'
import { lanePrLabel } from './pr-inspector/PrList'
import { TONE_CHIP } from './pr-inspector/PrIcons'
import { PrRail } from './pr-inspector/PrStageRail'
import type { InspectorFocus } from './pr-inspector/usePrInspector'

/**
 * The lane header's pull-request pill: the lead PR's number, its four-stage
 * rail and `+N` for the lane's other PRs. A real tab stop that opens the
 * lane's PR inspector; sidebar beads deliberately are not.
 *
 * A lane without a PR whose status is known shows nothing: no placeholder,
 * no "no PR". The listing keeps refreshing underneath, so a PR opened later
 * appears.
 */
export function LanePrStatus({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const { repoPath, ready, slice, prs, lead, branch, remote } = useLanePullRequests(sessionId, {
    all: open,
  })
  const enabled = useLanePrefsStore((s) => s.lanes.prStatus)
  if (!enabled || !repoPath || !lead?.pr) return null
  return (
    <LanePrPill
      key={`${sessionId}:${repoPath}`}
      sessionId={sessionId}
      lead={lead}
      open={open}
      onOpenChange={setOpen}
      lane={{ repoPath, ready, slice, prs, branch, remote }}
    />
  )
}

/** "Pull request #57: Rocky review failed (not required). 1 more pull request." */
export function lanePrPillLabel(lead: LanePr, prs: LanePrs): string {
  const more = prs.owned.length - 1
  const others = more > 0 ? ` ${more} more pull request${more === 1 ? '' : 's'}.` : ''
  return `Pull request ${lanePrLabel(lead, prs.home)}: ${lead.verdict.headline}.${others}`
}

function LanePrPill({
  sessionId,
  lead,
  open,
  onOpenChange,
  lane,
}: {
  sessionId: string
  lead: LanePr
  open: boolean
  onOpenChange: (open: boolean) => void
  lane: InspectorLane
}): React.JSX.Element {
  const prompting = useRef(false)
  const focus = useInspectorRequest(sessionId, onOpenChange)
  const more = lane.prs.owned.length - 1
  return (
    <LaneHeaderPill
      label={lanePrPillLabel(lead, lane.prs)}
      testId="lane-pr-status"
      variant={lead.verdict.tone}
      className={TONE_CHIP[lead.verdict.tone]}
      face={
        <>
          <span className="whitespace-nowrap">{lanePrLabel(lead, lane.prs.home)}</span>
          {lead.pr && <PrRail pr={lead.pr} />}
          {more > 0 && (
            <span className="text-text-secondary ml-px border-l border-current/20 pl-1.5">
              +{more}
            </span>
          )}
        </>
      }
      region="Pull request details"
      popupClassName="w-[720px]"
      open={open}
      onOpenChange={onOpenChange}
      holdOpen={() => prompting.current}
    >
      {(close) => (
        <LanePrInspector
          sessionId={sessionId}
          lane={lane}
          focus={focus}
          onClose={close}
          onPrompting={(value) => {
            prompting.current = value
          }}
        />
      )}
    </LaneHeaderPill>
  )
}

/**
 * Answer "open this lane's inspector" (a notice, the sidebar menu, Home):
 * open, select the asked-for PR, and clear the request.
 */
function useInspectorRequest(
  sessionId: string,
  onOpen: (open: boolean) => void,
): InspectorFocus | undefined {
  const request = usePrInspectorStore((s) =>
    s.request?.sessionId === sessionId ? s.request : null,
  )
  const [focus, setFocus] = useState<InspectorFocus>()
  useEffect(() => {
    if (!request) return
    const taken = usePrInspectorStore.getState().take(sessionId)
    if (!taken) return
    setFocus({ key: taken.key, at: taken.at })
    onOpen(true)
  }, [request, sessionId, onOpen])
  return focus
}
