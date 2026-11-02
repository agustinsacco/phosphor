import clsx from 'clsx'
import { Button } from '@/components/form'

/** One health fact: a dot, what it is, what the machine reports, and the one fix. */
export function StatusRow({
  label,
  ok,
  detail,
  action,
}: {
  label: string
  ok: boolean
  detail: string
  action?: { label: string; disabled: boolean; run: () => void }
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5">
      <span
        className={clsx('h-2 w-2 shrink-0 rounded-full', ok ? 'bg-success' : 'bg-warning')}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium">{label}</div>
        <div className="text-text-tertiary truncate font-mono text-sm">{detail}</div>
      </div>
      {action && (
        <Button size="sm" disabled={action.disabled} onClick={action.run} className="shrink-0">
          {action.label}
        </Button>
      )}
    </div>
  )
}

/**
 * "vX is available" + an Update button, tucked under the row it belongs to.
 *
 * Shared by the extension package and the `claude` CLI because both go stale
 * the same way: nothing moves them on its own, and the tab reads green while
 * they sit months behind.
 */
export function UpdateRow({
  latest,
  note,
  running,
  onUpdate,
}: {
  latest: string
  note: string
  running: boolean
  onUpdate: () => void
}): React.JSX.Element {
  return (
    <div className="border-border flex items-center justify-between gap-3 border-t px-3.5 py-2.5">
      <div className="text-base">
        <span className="text-accent font-medium">v{latest} is available.</span>{' '}
        <span className="text-text-secondary">{note}</span>
      </div>
      <Button variant="primary" size="sm" onClick={onUpdate} disabled={running}>
        {running ? 'Updating…' : 'Update'}
      </Button>
    </div>
  )
}
