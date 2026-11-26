import { PhosphorLoader } from '@/components/PhosphorLoader'
import { TooltipButton } from '@/components/Tooltip'

/** Loading and recovery stay inside the same menu as the models. */
export function ModelMenuStatus({
  loading,
  cold,
  error,
  onRetry,
}: {
  loading: boolean
  cold: boolean
  error?: string | null | undefined
  onRetry?: (() => void) | undefined
}): React.JSX.Element | null {
  if (loading)
    return (
      <div role="status" className="text-text-secondary flex items-center gap-2 px-3 py-2 text-sm">
        <PhosphorLoader size={16} decorative />
        {cold ? 'Loading models…' : 'Refreshing…'}
      </div>
    )
  if (!error) return null
  return (
    <div className="text-warning flex items-center gap-2 px-3 py-2 text-sm">
      <span role="status">{error}</span>
      {onRetry && (
        <TooltipButton
          className="hover:bg-bg-secondary text-text cursor-pointer rounded-md px-2 py-1"
          onClick={onRetry}
        >
          Retry
        </TooltipButton>
      )}
    </div>
  )
}
