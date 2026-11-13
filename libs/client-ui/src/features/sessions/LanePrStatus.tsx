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
  // Keyed by lane: switching lanes never carries an open inspector across.
  const [openFor, setOpenFor] = useState<string | null>(null)
  const [lane, setLane] = useState(sessionId)
  if (lane !== sessionId) {
    setLane(sessionId)
    setOpenFor(null)
  }
  const open = openFor === sessionId
  const { repoPath, ready, slice, prs, lead, branch, remote, byNumber } = useLanePullRequests(
    sessionId,
    {
      all: open,
    },
  )
  const enabled = useLanePrefsStore((s) => s.lanes.prStatus)
  const shown = enabled && !!repoPath && !!lead?.pr
  useEffect(() => {
    if (!shown) setOpenFor(null)
  }, [shown])
  if (!shown) return null
  return (
    <LanePrPill
      key={`${sessionId}:${repoPath}`}
      sessionId={sessionId}
      lead={lead}
      open={open}
      onOpenChange={(next) => setOpenFor(next ? sessionId : null)}
      // A Host lane whose Host reads by number gets detail like a This Mac lane;
      // an older Host's lane shows only what its listing says.
      lane={{ repoPath, ready, slice, prs, branch, remote: remote && !byNumber }}
    />
  )
}

/** "Pull request #57: Rocky review failed (not required). 1 more pull request." */
export function lanePrPillLabel(lead: LanePr, prs: LanePrs): string {
  const more = prs.owned.length - 1
  const others = more > 0 ? ` ${more} more pull request${more === 1 ? '' : 's'}.` : ''
  return `Pull request ${lanePrLabel(lead, prs)}: ${lead.verdict.headline}.${others}`
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
  const [focus, setFocus] = useState<InspectorFocus>()
  useInspectorRequest(sessionId, (request) => {
    setFocus(request)
    onOpenChange(true)
  })
  const more = lane.prs.owned.length - 1
  return (
    <LaneHeaderPill
      label={lanePrPillLabel(lead, lane.prs)}
      testId="lane-pr-status"
      variant={lead.verdict.tone}
      className={TONE_CHIP[lead.verdict.tone]}
      face={
        <>
          <span className="whitespace-nowrap">{lanePrLabel(lead, lane.prs)}</span>
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
      onOpenChange={(next) => {
        // A manual open starts on the lead PR, not on the last request's.
        if (!next) setFocus(undefined)
        onOpenChange(next)
      }}
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
function useInspectorRequest(sessionId: string, onRequest: (focus: InspectorFocus) => void): void {
  const request = usePrInspectorStore((s) =>
    s.request?.sessionId === sessionId ? s.request : null,
  )
  const answer = useRef(onRequest)
  answer.current = onRequest
  useEffect(() => {
    if (!request) return
    const taken = usePrInspectorStore.getState().take(sessionId)
    if (taken) answer.current({ key: taken.key, at: taken.at })
  }, [request, sessionId])
}
