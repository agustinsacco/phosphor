import { useState } from 'react'
import { PageShell } from '@/components/PageShell'
import { UnderlinedTabs } from '@/components/UnderlinedTabs'
import { Tag, Button } from '@/components/form'
import { useOpenSettings } from '@/features/settings/useOpenSettings'
import { usePlatform } from '@/platform/Platform'
import { useBrain } from './useBrain'
import { useBrainSync } from './useBrainSync'
import { BrainKnowledge } from './explorer/BrainKnowledge'
import { useExplorer } from './explorer/useExplorer'
import { BrainLanes } from './BrainLanes'
import { BrainTidy } from './tidy/BrainTidy'
import { useBrainTab } from './tidy/tidyNavigation'
import type { BrainStatus } from '@shared/brain'
import { formatCount } from '@/lib/format'

export function BrainPage(): React.JSX.Element {
  useBrainSync()
  const supported = usePlatform().localBrain
  const status = useBrain((s) => s.status)
  const error = useBrain((s) => s.error)
  const openSettings = useOpenSettings()
  return (
    <PageShell
      wide
      title={
        <span>
          Brain{' '}
          {status && (
            <span className="text-text-tertiary ml-3 text-sm font-normal">
              {formatCount(status.counts.memories, 'memory', 'memories')} ·{' '}
              {formatCount(status.counts.entities, 'person or thing', 'people and things')}
            </span>
          )}
        </span>
      }
      actions={
        supported && (
          <Button size="sm" onClick={() => openSettings('local', 'brain')}>
            Settings
          </Button>
        )
      }
    >
      {!supported ? (
        <p className="p-8">Brain is available on Desktop</p>
      ) : !status ? (
        <div role="status" className="p-8">
          {error || 'Loading Brain…'}
          <Button
            onClick={() => {
              void useBrain.getState().refresh()
            }}
          >
            Retry
          </Button>
        </div>
      ) : (
        <BrainContent key={status.generation} />
      )}
    </PageShell>
  )
}

function BrainContent(): React.JSX.Element {
  const status = useBrain((s) => s.status)!
  const { tab, setTab, recent } = useBrainTab(status)
  const explorer = useExplorer(tab === 'knowledge')
  const [selected, setSelected] = useState<string | null>(null)
  const [readId, setReadId] = useState<string | null>(null)
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <BrainTabs tab={tab} setTab={setTab} status={status} />
      <div
        id="brain-panel-knowledge"
        role="tabpanel"
        aria-labelledby="brain-tab-knowledge"
        className={tab === 'knowledge' ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}
      >
        {tab === 'knowledge' && (
          <BrainKnowledge
            state={explorer}
            onOpenRead={(id) => {
              setReadId(id)
              setTab('lanes')
            }}
          />
        )}
      </div>
      <div
        id="brain-panel-lanes"
        role="tabpanel"
        aria-labelledby="brain-tab-lanes"
        className={tab === 'lanes' ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}
      >
        {tab === 'lanes' && (
          <BrainLanes
            selected={selected}
            readId={readId}
            onSelect={(id) => {
              setSelected(id)
              setReadId(null)
            }}
            onMemory={(id, label) => {
              explorer.onVisit({ kind: 'memory', id, label })
              setTab('knowledge')
            }}
          />
        )}
      </div>
      {status.prefs.enabled && (
        <div
          id="brain-panel-tidy"
          role="tabpanel"
          aria-labelledby="brain-tab-tidy"
          className={tab === 'tidy' ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}
        >
          <BrainTidy
            active={tab === 'tidy'}
            recent={recent}
            onVisit={(visit) => {
              explorer.onVisit(visit)
              setTab('knowledge')
            }}
          />
        </div>
      )}
    </div>
  )
}

function BrainTabs({
  tab,
  setTab,
  status,
}: {
  tab: 'knowledge' | 'lanes' | 'tidy'
  setTab: (tab: 'knowledge' | 'lanes' | 'tidy') => void
  status: BrainStatus
}): React.JSX.Element {
  const reviews = status.jobs.filter((job) => job.state === 'review').length
  return (
    <UnderlinedTabs
      id="brain"
      label="Brain views"
      value={tab}
      onChange={setTab}
      tabs={[
        { value: 'knowledge', label: 'Knowledge' },
        {
          value: 'lanes',
          label: (
            <>Lanes {reviews > 0 && <Tag className="bg-accent-soft text-accent">{reviews}</Tag>}</>
          ),
        },
        ...(status.prefs.enabled
          ? [
              {
                value: 'tidy' as const,
                label: (
                  <>
                    Tidy{' '}
                    {status.tidy.open > 0 && (
                      <Tag className="bg-accent-soft text-accent">{status.tidy.open}</Tag>
                    )}
                  </>
                ),
              },
            ]
          : []),
      ]}
    />
  )
}
