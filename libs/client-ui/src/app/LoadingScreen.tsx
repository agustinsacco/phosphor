import { TooltipButton } from '@/components/Tooltip'
import { PhosphorLoader } from '@/components/PhosphorLoader'

/** App startup only — later session switches keep their local loading states. */
export function LoadingScreen({
  message = 'Preparing your workspace…',
  error,
  onRetry,
  onContinue,
}: {
  message?: string
  error?: string
  onRetry?: () => void
  onContinue?: () => void
}): React.JSX.Element {
  return (
    <div className="startup-screen" data-testid="startup-screen">
      <div className="titlebar-drag h-11 shrink-0" />
      <main className="startup-content">
        <PhosphorLoader size={56} decorative animated={!error} />
        <h1 className="startup-title">Phosphor</h1>
        <p className="startup-message" role={error ? 'alert' : 'status'}>
          {error ?? message}
        </p>
        {error && (
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            {onRetry && (
              <TooltipButton className="startup-action" onClick={onRetry}>
                Try again
              </TooltipButton>
            )}
            {onContinue && (
              <TooltipButton className="startup-action" onClick={onContinue}>
                Continue without restoring
              </TooltipButton>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
