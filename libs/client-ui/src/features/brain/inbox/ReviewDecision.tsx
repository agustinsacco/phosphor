import { useCallback, useEffect, useState } from 'react'
import type { BrainJob } from '@shared/brain'
import { ipcErrorText } from '@shared/errors'
import { Button } from '@/components/form'
import { useBrain } from '../useBrain'
import { useBrainResource } from '../useBrainResource'
import { BrainExtraction } from '../BrainExtraction'
import { DecisionFrame, type DecisionKeys } from './DecisionFrame'
import { ReviewForm } from './ReviewForm'
import { reloadsReview } from './reviewModel'

/** One lane read waiting for review: load its proposal and keep it honest while Brain changes. */
export function ReviewDecision({
  job,
  keys,
  onContext,
  onMemory,
}: {
  job: BrainJob
  keys: React.RefObject<DecisionKeys>
  onContext: (entityIds: string[]) => void
  onMemory: (id: string, label: string) => void
}): React.JSX.Element {
  const [stale, setStale] = useState(false)
  const [reading, setReading] = useState(false)
  const ready = job.state === 'review'
  const load = useCallback(async () => {
    try {
      return await window.phosphor.invoke('brain:proposal', job.id)
    } catch (cause) {
      if (reloadsReview(ipcErrorText(cause))) {
        setStale(true)
        await useBrain.getState().refresh()
      }
      throw cause
    }
  }, [job.id])
  const { data, error, retry } = useBrainResource(load, ready)
  useEffect(() => {
    if (data) setStale(false)
  }, [data])
  useEffect(() => {
    onContext(
      data?.identities.flatMap((identity) =>
        identity.entityId ? [identity.entityId] : identity.candidates.slice(0, 1).map((c) => c.id),
      ) ?? [],
    )
  }, [data, onContext])
  if (reading)
    return (
      <div className="brain-scroll">
        <BrainExtraction jobId={job.id} onMemory={onMemory} onBack={() => setReading(false)} />
      </div>
    )
  if (data && ready && !stale)
    return (
      <ReviewForm
        key={`${job.id}:${data.revision}`}
        proposal={data}
        keys={keys}
        onExtraction={() => setReading(true)}
        onStale={async () => {
          setStale(true)
          await useBrain.getState().refresh()
          retry()
        }}
      />
    )
  return (
    <DecisionFrame label="Lane read" eyebrow="From lanes" title={job.title}>
      <div role="status" className="space-y-2">
        {stale || !ready ? (
          <p>Refreshing this review: Brain changed since it was read. Nothing to do.</p>
        ) : (
          <p>{error || 'Loading review…'}</p>
        )}
        {error && ready && <Button onClick={retry}>Retry</Button>}
      </div>
    </DecisionFrame>
  )
}
