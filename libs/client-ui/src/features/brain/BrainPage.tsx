import { BrainKnowledge } from './explorer/BrainKnowledge'
import { useEffect, useState } from 'react'
import { PageShell } from '@/components/PageShell'
import { Button } from '@/components/form'
import { useOpenSettings } from '@/features/settings/useOpenSettings'
import { usePlatform } from '@/platform/Platform'
import { useBrain, useBrainSync } from './useBrain'
import { BrainHistory } from './BrainHistory'
import { BrainInbox } from './BrainInbox'
import { BrainExtraction } from './BrainExtraction'
import { BrainReview } from './BrainReview'
import { useExplorer } from './explorer/useExplorer'
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
              {formatCount(status.counts.entities, 'thing')}
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

// bridge: replaced by the Lanes worker's BrainPage at merge
function BrainContent(): React.JSX.Element {
  const explorer = useExplorer()
  const [review, setReview] = useState<string | null>(null)
  const [extraction, setExtraction] = useState<string | null>(null)
  const jobs = useBrain((s) => s.status?.jobs ?? [])
  useEffect(() => {
    if (extraction && jobs.some((job) => job.replaces === extraction)) setExtraction(null)
  }, [extraction, jobs])
  const close = (): void => {
    setReview(null)
    setExtraction(null)
  }
  const openExtraction = (id: string): void => {
    setReview(null)
    setExtraction(id)
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {extraction ? (
        <div className="overflow-auto">
          <BrainExtraction
            jobId={extraction}
            onBack={close}
            onMemory={(id) => {
              explorer.onVisit({ kind: 'memory', id, label: 'Memory' })
              close()
            }}
          />
        </div>
      ) : review ? (
        <div className="overflow-auto">
          <Button onClick={close}>Back</Button>
          <BrainReview jobId={review} onClose={close} onExtraction={openExtraction} />
        </div>
      ) : (
        <>
          <div className="max-h-48 shrink-0 overflow-auto">
            <BrainInbox jobs={jobs} onReview={setReview} onExtraction={openExtraction} />
            <BrainHistory onExtraction={openExtraction} />
          </div>
          <BrainKnowledge state={explorer} onOpenRead={openExtraction} />
        </>
      )}
    </div>
  )
}
