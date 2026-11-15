import type { GhPrDetail, GhPrSummary } from '@shared/models'
import type { LanePr } from '../lanePrs'
import type { PrHandoff } from '../prHandoff'
import type { CheckGroups } from './checkGroups'
import { PrChecksTab } from './PrChecksTab'
import { PrOverview } from './PrOverview'
import { PrActivityTab, PrPeople, PrThreadsTab } from './PrPeopleTabs'
import { panelId, tabId, type PrTabId } from './PrTabs'

/** The selected tab's content. */
function TabContent({
  tab,
  item,
  summary,
  detail,
  groups,
  loading,
  seenAt,
  onHandoff,
  onOpen,
}: {
  tab: PrTabId
  item: LanePr
  summary: GhPrSummary | undefined
  detail: GhPrDetail | undefined
  groups: CheckGroups
  loading: boolean
  seenAt?: number
  onHandoff: (kind: PrHandoff) => void
  onOpen: (url: string) => void
}): React.JSX.Element {
  switch (tab) {
    case 'overview':
      return (
        <PrOverview
          pr={item.pr}
          detail={detail}
          loading={loading}
          onHandoff={onHandoff}
          onOpen={onOpen}
        />
      )
    case 'checks':
      return <PrChecksTab groups={groups} loading={loading} onOpen={onOpen} />
    case 'reviews':
      return summary ? (
        <PrPeople summary={summary} detail={detail} />
      ) : (
        <p className="text-text-secondary text-base">
          Reviewers are not available for this pull request.
        </p>
      )
    case 'threads':
      return (
        <PrThreadsTab
          summary={summary}
          detail={detail}
          loading={loading}
          onOpen={onOpen}
          onAddress={summary?.threads?.unresolved ? () => onHandoff('address-threads') : undefined}
        />
      )
    case 'activity':
      return <PrActivityTab detail={detail} loading={loading} seenAt={seenAt} />
  }
}

type PanelProps = Parameters<typeof TabContent>[0]

/** The scrolling panel under the tabs; the header and tabs above it stay put. */
export function PrTabPanel({ base, ...props }: PanelProps & { base: string }): React.JSX.Element {
  return (
    <div
      role="tabpanel"
      id={panelId(base, props.tab)}
      aria-labelledby={tabId(base, props.tab)}
      tabIndex={0}
      data-testid="pr-inspector-panel"
      className="focus-visible:outline-accent min-h-0 flex-1 overflow-y-auto px-3 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2"
    >
      <TabContent {...props} />
    </div>
  )
}
