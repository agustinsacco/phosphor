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
      <main className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 pb-11 text-center">
        <PhosphorLoader size={80} decorative animated={!error} />
        <h1 className="mt-6 font-mono text-3xl font-medium tracking-tight">Phosphor</h1>
        <p className="text-text-secondary mt-3 text-lg" role={error ? 'alert' : 'status'}>
          {error ?? message}
        </p>
        {error && (
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            {onRetry && (
              <button className="startup-action" onClick={onRetry}>
                Try again
              </button>
            )}
            {onContinue && (
              <button className="startup-action" onClick={onContinue}>
                Continue without restoring
              </button>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
