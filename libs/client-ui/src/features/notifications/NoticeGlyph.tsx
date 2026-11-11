import type { Toast } from '@/stores/extensionUi'
import { CheckIcon, WarningIcon } from '@/components/icons'

/**
 * The card's leading mark. A lane notice leads with the lane's own marker —
 * the same emoji as its sidebar row, which is how you recognise it — with the
 * outcome as a small badge on it; everything else leads with the outcome.
 */
export function NoticeGlyph({
  toast,
  ground = 'bg-surface-raised',
}: {
  toast: Pick<Toast, 'kind' | 'marker'>
  /** The surface under the badge, so its ring matches a card or a drawer row. */
  ground?: string
}): React.JSX.Element {
  const badge =
    toast.kind === 'success' ? (
      <span className="bg-success text-bg flex h-full w-full items-center justify-center rounded-full">
        <CheckIcon size={toast.marker ? 7 : 10} />
      </span>
    ) : toast.kind === 'error' || toast.kind === 'warning' ? (
      <WarningIcon
        size={toast.marker ? 10 : 14}
        className={toast.kind === 'error' ? 'text-danger' : 'text-warning'}
      />
    ) : null
  if (toast.marker) {
    return (
      <span className="relative mt-px flex h-5 w-5 shrink-0 items-center justify-center text-base leading-none">
        {toast.marker}
        {badge && (
          <span
            className={`${ground} absolute -right-1 -bottom-1 flex h-3 w-3 items-center justify-center rounded-full`}
          >
            {badge}
          </span>
        )}
      </span>
    )
  }
  if (badge) {
    return <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{badge}</span>
  }
  return <span className="bg-info mt-1.5 h-2 w-2 shrink-0 rounded-full" />
}
