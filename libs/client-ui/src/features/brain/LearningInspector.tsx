import { useCallback, useState } from 'react'
import type { BrainLearningDetail } from '@shared/brain-learning-jobs'
import type { BrainLearningUsage } from '@shared/brain-learning'
import { ModalOverlay } from '@/components/Modal'
import { Button } from '@/components/form'
import { LearningSource } from './LearningSource'
import { LearningReview } from './LearningReview'
import { useLearningResource } from './useLearningResource'
import { activeLearning, refreshLearning, useLearningUi } from './learningUi'
import type { BrainAction } from './useBrain'

const close = (): void => useLearningUi.setState({ jobId: null })
export function LearningInspector({ jobId }: { jobId: string }): React.JSX.Element {
  const update = useLearningUi((s) => {
    const job = s.jobs.find((item) => item.id === jobId)
    return job ? `${job.state}:${job.updatedAt}:${job.fence}` : null
  })
  const load = useCallback(async () => {
    const [detail, status] = await Promise.all([
      window.phosphor.invoke('brain:learningDetail', jobId),
      window.phosphor.invoke('brain:status'),
    ])
    return { detail, status }
  }, [jobId])
  const { data, error, retry } = useLearningResource(load, update)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const act: BrainAction = async (operation) => {
    if (busy) return false
    setBusy(true)
    setActionError('')
    try {
      await operation()
      retry()
      refreshLearning()
      return true
    } catch (cause) {
      setActionError(String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }
  return (
    <ModalOverlay onClose={close}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Private learning inspector"
        className="brain-learning-dialog"
      >
        <h2>Private learning inspector · read-only</h2>
        <p>
          No composer, resume, fork or edit. This is a private job, not an ordinary lane. Temporary
          copied source is deleted after completion. Original source branch is unchanged.
        </p>
        {!data && !error && <p role="status">Loading private learning job…</p>}
        {error && (
          <div role="alert">
            {error}
            <Button onClick={retry}>Retry inspector</Button>
          </div>
        )}
        {actionError && <p role="alert">{actionError}</p>}
        {data && <LearningJobDetail detail={data.detail} />}
        {data && activeLearning(data.detail.job) && (
          <Button
            disabled={busy}
            onClick={() => {
              void act(() => window.phosphor.invoke('brain:cancel', jobId))
            }}
          >
            Cancel learning
          </Button>
        )}
        {data && (
          <LearningReview
            detail={data.detail}
            snapshot={data.status.snapshot}
            busy={busy}
            act={act}
          />
        )}
        <Button onClick={close}>Close inspector</Button>
      </section>
    </ModalOverlay>
  )
}

function LearningJobDetail({ detail }: { detail: BrainLearningDetail }): React.JSX.Element {
  const { job, outcome } = detail
  const learning = job.learning
  return (
    <>
      <p>
        Job {job.id} · {job.state} · scope {job.scope}
      </p>
      {job.error && <p role="alert">{job.error}</p>}
      {learning ? (
        <>
          <p>
            Source: {learning.target.workspacePath} · {learning.target.sessionPath}
          </p>
          <LearningSource
            checkpoint={learning}
            {...learning}
            reprocessed={learning.retryOf !== undefined}
          />
          <LearningUsage usage={learning.usage} />
        </>
      ) : (
        <p>Learning metadata unavailable.</p>
      )}
      {(outcome?.type === 'no_findings' || learning?.outcome === 'no_findings') && (
        <p>Completed · no findings. No proposal to review.</p>
      )}
      {(outcome?.type === 'findings' || learning?.outcome === 'findings') && (
        <p>
          Findings are proposals, not accepted facts. Review exact citations and original evidence
          below.
        </p>
      )}
      <p>
        Failed or cancelled attempts may already have incurred unreported usage. No cache prefix,
        cache reuse or warm-process reuse is promised.
      </p>
    </>
  )
}

function LearningUsage({ usage }: { usage: BrainLearningUsage | null }): React.JSX.Element {
  const value = (key: keyof BrainLearningUsage): string =>
    usage?.[key]?.toLocaleString() ?? 'Unavailable'
  return (
    <section className="brain-card" aria-label="Actual response usage">
      <h3>Actual response usage · tokens</h3>
      <p>
        Input: {value('input')} · Output: {value('output')}
      </p>
      <p>
        Cache read: {value('cacheRead')} · Cache write: {value('cacheWrite')}
      </p>
      <p>Reasoning (included in output): {value('reasoning')}</p>
      <p>
        Unavailable means unreported, not zero. These are not cumulative source totals or a
        dollar-price estimate.
      </p>
    </section>
  )
}
