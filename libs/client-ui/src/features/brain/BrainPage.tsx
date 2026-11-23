import { useState } from 'react'
import type { BrainStatus } from '@shared/brain'
import { PageShell } from '@/components/PageShell'
import { UnderlinedTabs } from '@/components/UnderlinedTabs'
import { Button } from '@/components/form'
import { useOpenSettings } from '@/features/settings/useOpenSettings'
import { usePlatform } from '@/platform/Platform'
import { formatCount } from '@/lib/format'
import { useBrain } from './useBrain'
import { useBrainSync } from './useBrainSync'
import { openBrain, useBrainTab, type BrainTab } from './brainNavigation'
import { waitingCount, waitingBreakdown, defragRefusal } from './agentStatus'
import { BrainKnowledge } from './explorer/BrainKnowledge'
import { useExplorer } from './explorer/useExplorer'
import { BrainLanes } from './lanes/BrainLanes'
import type { LaneSelection } from './lanes/laneGroups'
import { BrainStatusStrip } from './BrainStatusStrip'
import { useBrainTargets } from './useBrainTargets'
import { pageKeyTarget } from './pageKeys'
import './brain.css'

export function BrainPage(): React.JSX.Element {
  useBrainSync()
  const supported = usePlatform().localBrain
  const status = useBrain((s) => s.status)
  const error = useBrain((s) => s.error)
  const openSettings = useOpenSettings()
  const [startingDefrag, setStartingDefrag] = useState(false)
  return (
    <PageShell
      wide
      title={brainTitle(status)}
      actions={
        supported && (
          <>
            {status && (
              <Button
                size="sm"
                tooltip={{ label: 'Go to anyone or anything', shortcut: ['/'] }}
                className="text-text-tertiary flex items-center gap-2"
                onClick={() => openBrain({ tab: 'knowledge', search: true })}
              >
                <span aria-hidden="true">⌕</span>
                <span className="brain-search-label">Go to anyone or anything</span>
                <kbd className="border-border rounded-sm border px-1 font-mono text-2xs">/</kbd>
              </Button>
            )}
            <Button size="sm" onClick={() => openSettings('local', 'brain')}>
              Settings
            </Button>
            {status && (
              <Button
                size="sm"
                variant="primary"
                disabled={startingDefrag || !!defragRefusal(status)}
                tooltip={
                  startingDefrag
                    ? 'Defrag is starting.'
                    : (defragRefusal(status) ?? waitingBreakdown(status.agent.waiting))
                }
                onClick={() => {
                  setStartingDefrag(true)
                  void useBrain
                    .getState()
                    .defrag()
                    .then(() => setStartingDefrag(false))
                }}
              >
                Defrag
              </Button>
            )}
          </>
        )
      }
    >
      {!supported ? (
        <p className="p-8">Brain is available on Desktop</p>
      ) : !status ? (
        <div role="status" className="p-8">
          {error || 'Loading Brain…'}
          {error && (
            <Button
              onClick={() => {
                void useBrain.getState().refresh()
              }}
            >
              Retry
            </Button>
          )}
        </div>
      ) : (
        <BrainContent key={status.generation} />
      )}
    </PageShell>
  )
}

function BrainContent(): React.JSX.Element {
  const status = useBrain((s) => s.status)!
  const { tab, setTab, target } = useBrainTab(status)
  const explorer = useExplorer()
  const [lane, setLane] = useState<LaneSelection | null>(null)
  const [searchRequest, setSearchRequest] = useState(0)
  useBrainTargets(target, {
    setLane,
    focusSearch: () => setSearchRequest((n) => n + 1),
  })
  return (
    <div
      className="brain-page"
      onKeyDown={(event) => {
        if (!pageKeyTarget(event, '/')) return
        event.preventDefault()
        setTab('knowledge')
        setSearchRequest((n) => n + 1)
      }}
    >
      <BrainTabs tab={tab} setTab={setTab} />
      <BrainStatusStrip onLanes={() => setTab('lanes')} />
      <Panel id="knowledge" tab={tab}>
        <BrainKnowledge
          state={explorer}
          searchRequest={searchRequest}
          onOpenRead={(jobId) => {
            setLane({ type: 'job', id: jobId })
            setTab('lanes')
          }}
        />
      </Panel>
      <Panel id="lanes" tab={tab}>
        <BrainLanes
          selected={lane}
          onSelect={setLane}
          onMemory={(id, label) => {
            explorer.onVisit({ kind: 'memory', id, label })
            setTab('knowledge')
          }}
        />
      </Panel>
    </div>
  )
}

function Panel({
  id,
  tab,
  children,
}: {
  id: BrainTab
  tab: BrainTab
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      id={`brain-panel-${id}`}
      role="tabpanel"
      aria-labelledby={`brain-tab-${id}`}
      className={tab === id ? 'brain-panel' : 'hidden'}
    >
      {tab === id && children}
    </div>
  )
}

function BrainTabs({
  tab,
  setTab,
}: {
  tab: BrainTab
  setTab: (tab: BrainTab) => void
}): React.JSX.Element {
  return (
    <UnderlinedTabs
      id="brain"
      label="Brain views"
      value={tab}
      onChange={setTab}
      tabs={[
        { value: 'knowledge', label: 'Knowledge' },
        { value: 'lanes', label: 'Lanes' },
      ]}
    />
  )
}

function brainTitle(status: BrainStatus | null): React.JSX.Element {
  return (
    <span>
      Brain{' '}
      {status && (
        <span className="text-text-tertiary ml-3 text-sm font-normal">
          {formatCount(status.counts.memories, 'memory', 'memories')} ·{' '}
          {formatCount(status.counts.entities, 'person or thing', 'people and things')} ·{' '}
          {waitingCount(status)} waiting
        </span>
      )}
    </span>
  )
}
