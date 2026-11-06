import { useSessionTransition } from './sessionTransition'
import { TooltipButton } from '@/components/Tooltip'

export function SessionTransitionBanner({
  sessionId,
}: {
  sessionId: string
}): React.JSX.Element | null {
  const state = useSessionTransition((s) => s.bySession[sessionId])
  if (!state) return null
  return (
    <div role="status" className="text-text-secondary mx-auto mb-2 max-w-3xl text-sm">
      {state.busy ? (
        'Loading session…'
      ) : (
        <>
          Session loading failed.{' '}
          <TooltipButton
            className="underline"
            onClick={() => {
              void state.retry?.()
            }}
          >
            Retry loading
          </TooltipButton>
        </>
      )}
    </div>
  )
}
