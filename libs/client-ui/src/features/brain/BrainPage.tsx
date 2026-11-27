import { useState } from 'react'
import type { BrainStatus } from '@shared/brain'
import { PageShell } from '@/components/PageShell'
import { Button } from '@/components/form'
import { useOpenSettings } from '@/features/settings/useOpenSettings'
import { usePlatform } from '@/platform/Platform'
import { useNavigation } from '@/navigation/Navigation'
import { locationMachine } from '@/navigation/location'
import { brainMachine } from './brainMachine'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { HostBrainPage } from './HostBrainPage'
import { formatCount } from '@/lib/format'
import { useBrain } from './useBrain'
import { useBrainSync } from './useBrainSync'
import { openBrain } from './brainNavigation'
import { waitingCount, waitingBreakdown, defragRefusal } from './agentStatus'
import { BrainScreen } from './screen/BrainScreen'
import './brain.css'
import './map/map.css'

export function BrainPage(): React.JSX.Element {
  const { location } = useNavigation()
  const platform = usePlatform()
  const explicit = locationMachine(location)
  const selected = useRemoteLanesStore((s) =>
    brainMachine(
      explicit ?? (platform.localLanes ? s.filter : 'all'),
      s.hosts,
      platform.desktopBrainOwner,
    ),
  )
  if (selected === 'local' && platform.localBrain) return <LegacyBrainPage />
  return (
    <HostBrainPage hostId={selected !== 'local' && selected !== 'all' ? selected : undefined} />
  )
}

function LegacyBrainPage(): React.JSX.Element {
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
                tooltip={{ label: 'Search Brain', shortcut: ['/'] }}
                className="text-text-tertiary flex items-center gap-2"
                onClick={() => openBrain({ search: true })}
              >
                <span aria-hidden="true">⌕</span>
                <span className="brain-search-label">Search</span>
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
        <BrainScreen key={status.generation} status={status} />
      )}
    </PageShell>
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
