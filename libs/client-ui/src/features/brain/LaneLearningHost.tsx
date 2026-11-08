import { useEffect } from 'react'
import { usePlatform } from '@/platform/Platform'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { Button } from '@/components/form'
import { LearningConsent } from './LearningConsent'
import { LearningInspector } from './LearningInspector'
import { useLearningProjection } from './useLearningProjection'
import { refreshLearning, useLearningUi } from './learningUi'
import './brain.css'

/** A single local-shell owner; capability AND actual machine selection must allow it. */
export function LaneLearningHost({ ready }: { ready: boolean }): React.JSX.Element | null {
  const { localBrain } = usePlatform()
  const machine = useRemoteLanesStore((s) => s.filter)
  if (!localBrain || (machine !== 'all' && machine !== 'local')) return null
  return <LocalLearningHost key={machine} ready={ready} />
}
function LocalLearningHost({ ready }: { ready: boolean }): React.JSX.Element {
  const error = useLearningProjection(ready)
  const target = useLearningUi((s) => s.target)
  const policyEpoch = useLearningUi((s) => s.policyEpoch)
  const jobId = useLearningUi((s) => s.jobId)
  const truncated = useLearningUi((s) => s.truncated)
  useEffect(
    () => () =>
      useLearningUi.setState({
        policyEpoch: null,
        enabled: false,
        workspaces: [],
        target: null,
        jobId: null,
        jobs: [],
        truncated: false,
      }),
    [],
  )
  return (
    <>
      {error && (
        <div role="alert">
          Learning status unavailable: {error}
          <Button onClick={refreshLearning}>Retry learning status</Button>
        </div>
      )}
      {truncated && <p role="status">Some learning jobs are omitted from this bounded list.</p>}
      {ready && policyEpoch !== null && target && (
        <LearningConsent key={`${target.workspacePath}:${target.sessionPath}`} target={target} />
      )}
      {ready && jobId && <LearningInspector key={jobId} jobId={jobId} />}
    </>
  )
}
