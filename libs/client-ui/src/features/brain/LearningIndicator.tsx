import { usePlatform } from '@/platform/Platform'
import { TooltipButton } from '@/components/Tooltip'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { activeLearning, inspectLearning, useLearningUi } from './learningUi'

/** No per-row requests or timers. Static blue also respects reduced motion. */
export function LearningIndicator({
  sessionPath,
}: {
  sessionPath: string
}): React.JSX.Element | null {
  const { localBrain } = usePlatform()
  const machine = useRemoteLanesStore((s) => s.filter)
  const job = useLearningUi((s) =>
    s.jobs.find((j) => activeLearning(j) && j.learning?.target.sessionPath === sessionPath),
  )
  if (!localBrain || (machine !== 'local' && machine !== 'all') || !job) return null
  return (
    <TooltipButton
      type="button"
      data-testid="learning-indicator"
      className="shrink-0 rounded px-1 text-xs text-blue-500 hover:underline"
      tooltip="Open private read-only learning inspector"
      onClick={(event) => {
        event.stopPropagation()
        inspectLearning(job.id)
      }}
    >
      Learning · {job.state}
    </TooltipButton>
  )
}
