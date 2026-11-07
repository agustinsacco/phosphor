import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BrainLearningTarget,
  BrainLearningPreview,
  BrainLearningDetail,
} from '@shared/brain-learning-jobs'
import { ModalOverlay } from '@/components/Modal'
import { Button } from '@/components/form'
import { LearningTerms } from './LearningTerms'
import { useLearningSourceBusy } from './useLearningSourceBusy'
import { useLearningResource } from './useLearningResource'
import { inspectLearning, refreshLearning, useLearningUi } from './learningUi'

const close = (): void => useLearningUi.setState({ target: null })

export function LearningConsent({ target }: { target: BrainLearningTarget }): React.JSX.Element {
  const sourceBusy = useLearningSourceBusy(target)
  return (
    <ModalOverlay onClose={close}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Learn from this lane"
        className="brain-learning-dialog"
      >
        <h2>Learn from this lane</h2>
        <p>
          {target.workspacePath} · {target.sessionPath}
        </p>
        {sourceBusy ? (
          <p role="status">
            Source is busy or unavailable. Wait for it to be ready before preflight.
          </p>
        ) : (
          <LearningPreflight target={target} />
        )}
        <Button onClick={close}>Close</Button>
      </section>
    </ModalOverlay>
  )
}
function LearningPreflight({ target }: { target: BrainLearningTarget }): React.JSX.Element {
  const policyEpoch = useLearningUi((s) => s.policyEpoch)
  const load = useCallback(async () => {
    const preview = await window.phosphor.invoke('brain:learnPreview', target)
    const previous = preview.previousJobId
      ? await window.phosphor.invoke('brain:learningDetail', preview.previousJobId)
      : null
    return { preview, previous }
  }, [target])
  const { data, error, retry } = useLearningResource(load, policyEpoch)
  return (
    <>
      {!data && !error && <p role="status">Checking source and account…</p>}
      {error && (
        <div role="alert">
          {error}
          <Button onClick={retry}>Retry preflight</Button>
        </div>
      )}
      {data && <ConsentReady key={data.preview.fingerprint} {...data} />}
    </>
  )
}

type ReadyProps = { preview: BrainLearningPreview; previous: BrainLearningDetail | null }

function ConsentReady({ preview, previous }: ReadyProps): React.JSX.Element {
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const reprocess = previous !== null
  const start = async (): Promise<void> => {
    if (!consent || busy) return
    setBusy(true)
    setError('')
    try {
      const job = await window.phosphor.invoke('brain:learn', preview.target, {
        policyEpoch: preview.policyEpoch,
        fingerprint: preview.fingerprint,
        ...(previous ? { retryJobId: previous.job.id } : {}),
      })
      if (alive.current) {
        refreshLearning()
        inspectLearning(job.id)
      }
    } catch (cause) {
      if (alive.current) {
        setError(String(cause))
        setConsent(false)
      }
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  return (
    <>
      <LearningTerms preview={preview} previous={previous} reprocess={reprocess} />
      <label className="brain-field">
        <span>
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />{' '}
          I consent to this exact checkpoint, source provider/model/thinking, current account slot,
          and one logical generation with manual review.
          {reprocess &&
            ' I explicitly authorize reprocessing, which may incur another charge, instead of only opening the prior result.'}
        </span>
      </label>
      {error && (
        <p role="alert">
          {error} Close and reopen to refresh consent if the source or policy changed.
        </p>
      )}
      <Button
        disabled={!consent || busy}
        onClick={() => {
          void start()
        }}
      >
        {reprocess ? 'Retry / reprocess explicitly' : 'Learn once'}
      </Button>
      {previous && (
        <Button disabled={busy} onClick={() => inspectLearning(previous.job.id)}>
          Inspect previous attempt
        </Button>
      )}
    </>
  )
}
