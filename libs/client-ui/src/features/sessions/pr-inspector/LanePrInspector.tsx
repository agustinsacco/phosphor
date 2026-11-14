import { useId, useState } from 'react'
import { prDetailOf, usePrDetailStore } from '@/stores/prDetail'
import { prStatusOf, usePrStatusStore } from '@/stores/prStatus'
import type { RepoPullRequests } from '@/stores/pullRequests'
import type { ClosePill } from '../LaneHeaderPill'
import type { LanePr, LanePrs } from '../lanePrs'
import { isSummary } from '../prVerdict'
import { groupChecks, inspectorChecks } from './checkGroups'
import { prFreshness } from './prFreshness'
import { PrHeader, SinceYouLooked } from './PrHeader'
import { PrHeaderActions } from './PrHeaderActions'
import { PrList } from './PrList'
import { PrTabPanel } from './PrTabPanel'
import { prTabs, PrTabList, type PrTabId } from './PrTabs'
import { useInspectorActions } from './useInspectorActions'
import { useInspectorRefresh, usePrInspector, type InspectorFocus } from './usePrInspector'
import './prInspector.css'

export interface InspectorLane {
  repoPath?: string
  ready: boolean
  slice: RepoPullRequests
  prs: LanePrs
  branch?: string
  remote: boolean
}

interface LanePrInspectorProps {
  sessionId: string
  lane: InspectorLane
  focus?: InspectorFocus
  onClose: ClosePill
  /** A dialog the inspector opened is on top. */
  onPrompting: (prompting: boolean) => void
}

/** The shown PR's status entry, detail and checks. */
function useShownPr(item: LanePr | undefined, remote: boolean) {
  const entry = usePrStatusStore((s) => prStatusOf(s, item?.key))
  const detailEntry = usePrDetailStore((s) => prDetailOf(s, item?.key))
  const summary = isSummary(item?.pr) ? item.pr : undefined
  const detail = detailEntry.detail
  const loading = detailEntry.loading || (!!item?.ref && !remote && !detailEntry.attemptedAt)
  const { checks, truncated } = inspectorChecks(summary, detail)
  return { entry, detailEntry, summary, detail, loading, groups: groupChecks(checks, truncated) }
}

function InspectorError({ error }: { error: string | null }): React.JSX.Element | null {
  if (!error) return null
  return (
    <p
      role="alert"
      className="border-danger/30 bg-danger-soft text-text mx-3 mt-2 rounded-md border px-2 py-1 text-base"
    >
      {error}
    </p>
  )
}

function laneNotes(lane: InspectorLane): string[] {
  return [
    !lane.ready && 'Repository unavailable. Reconnect to refresh.',
    !lane.slice.coverage &&
      lane.repoPath?.startsWith('host:') &&
      'The Host may reuse its repository cache for up to 60 seconds.',
  ].filter((note): note is string => !!note)
}

/**
 * The lane's PR inspector: its PRs on the left, the selected one on the
 * right with Overview, Checks, Reviews, Threads and Activity. Read-only on
 * GitHub: hand-offs draft into the composer, Track and Hide go through the
 * lane's own session file.
 *
 * Tab order is list, tabs, panel, then the header's actions, which are drawn
 * in the header's corner but come last in the DOM.
 */
export function LanePrInspector({
  sessionId,
  lane,
  focus,
  onClose,
  onPrompting,
}: LanePrInspectorProps): React.JSX.Element | null {
  const { prs, remote } = lane
  const base = useId()
  const model = usePrInspector(prs, remote, focus)
  const item = model.selected
  const [tab, setTab] = useState<PrTabId>('overview')
  const { entry, detailEntry, summary, detail, loading, groups } = useShownPr(item, remote)
  const refresh = useInspectorRefresh(lane.repoPath, prs, item, remote)
  const act = useInspectorActions({
    sessionId,
    prs,
    summary,
    detail,
    select: model.select,
    onClose,
    onPrompting,
  })
  if (!item) return null
  return (
    <div className="pr-inspector" data-testid="pr-inspector">
      <div className="pr-inspector-grid h-[min(540px,calc(100dvh-88px))]">
        <PrList
          prs={prs}
          selected={item.key}
          onSelect={model.select}
          onTrack={(ref) => act.override('pin', ref)}
          onTrackOther={act.trackOther}
        />
        <section
          className="relative flex min-h-0 min-w-0 flex-col"
          aria-label="Selected pull request"
        >
          <PrHeader
            item={item}
            fresh={prFreshness(item, entry, lane.slice, lane.branch)}
            notes={laneNotes(lane)}
          />
          <SinceYouLooked baseline={model.baseline} summary={summary} />
          <InspectorError error={act.error} />
          <PrTabList
            base={base}
            tabs={prTabs(summary, detail, groups)}
            active={tab}
            onChange={setTab}
          />
          <PrTabPanel
            base={base}
            tab={tab}
            item={item}
            summary={summary}
            detail={detail}
            groups={groups}
            loading={loading}
            seenAt={model.baseline?.seenAt}
            onHandoff={act.handoff}
            onOpen={act.open}
          />
          <PrHeaderActions
            item={item}
            suggestion={!prs.owned.some((owned) => owned.key === item.key)}
            refreshing={lane.slice.loading || detailEntry.loading}
            act={act}
            onRefresh={refresh}
          />
        </section>
      </div>
    </div>
  )
}
