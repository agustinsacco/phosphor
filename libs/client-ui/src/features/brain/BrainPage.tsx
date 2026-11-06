import { useState } from 'react'
import { usePlatform } from '@/platform/Platform'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { PageShell } from '@/components/PageShell'
import { PageBody } from '@/components/PageBody'
import { Button } from '@/components/form'
import { BrainExplore } from './BrainExplore'
import { BrainActivity } from './BrainActivity'
import { BrainSettings } from './BrainSettings'
import { useBrain } from './useBrain'
import './brain.css'

export function BrainPage(): React.JSX.Element {
  const { localBrain } = usePlatform()
  const machine = useRemoteLanesStore((s) => s.filter)
  const available = localBrain && (machine === 'local' || machine === 'all')
  return (
    <PageShell title="Brain · This Mac">
      <PageBody className="brain-page">
        {available ? (
          <LocalBrain key={machine} />
        ) : (
          <p role="status">
            Brain is unavailable on this machine or in the web client. This prototype only runs
            locally on Desktop. No request was routed to This Mac.
          </p>
        )}
      </PageBody>
    </PageShell>
  )
}

function LocalBrain(): React.JSX.Element {
  const { status, error, busy, refresh, act } = useBrain()
  const [tab, setTab] = useState<'Explore' | 'Activity' | 'Settings'>('Explore')
  return (
    <>
      <p className="text-text-secondary">
        Private, machine-local memory. Manual processing, human review. No cross-machine sync.
      </p>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Button
            onClick={() => {
              void refresh()
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {!status && !error && <p role="status">Loading Brain…</p>}
      {status && !status.supported && (
        <p role="status">Brain is unavailable on this Desktop runtime. {status.notice}</p>
      )}
      {status?.supported && (
        <>
          <nav aria-label="Brain sections" className="brain-actions">
            {(['Explore', 'Activity', 'Settings'] as const).map((name) => (
              <Button key={name} aria-pressed={tab === name} onClick={() => setTab(name)}>
                {name}
              </Button>
            ))}
          </nav>
          {!status.snapshot.prefs.enabled && (
            <p role="status">
              Brain is off by default. Enable and enroll workspaces in Settings. Disabling preserves
              memory and downloaded models.
            </p>
          )}
          {status.snapshot.truncated && (
            <p role="status">
              Partial snapshot: row or byte limits hide some data. Search narrows claims; Activity
              prioritizes pending work and provides pages of captured evidence.
            </p>
          )}
          {tab === 'Explore' && <BrainExplore snapshot={status.snapshot} busy={busy} act={act} />}
          {tab === 'Activity' && <BrainActivity snapshot={status.snapshot} busy={busy} act={act} />}
          {tab === 'Settings' && <BrainSettings status={status} busy={busy} act={act} />}
        </>
      )}
    </>
  )
}
