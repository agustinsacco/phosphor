import clsx from 'clsx'
import { Button } from './fields'

export type NoticeTone = 'info' | 'warning' | 'danger'

export interface SettingsNoticeAction {
  label: string
  onClick: () => void
  /** Shown in place of `label` while the action runs; the button is disabled meanwhile. */
  busyLabel?: string
  busy?: boolean
  disabled?: boolean
}

export interface SettingsNoticeProps {
  tone: NoticeTone
  title: string
  body?: React.ReactNode
  action?: SettingsNoticeAction
}

const TONES: Record<NoticeTone, { box: string; title: string }> = {
  info: { box: 'border-border bg-bg-secondary', title: 'text-text' },
  warning: { box: 'border-warning/30 bg-warning/5', title: 'text-warning' },
  danger: { box: 'border-danger/30 bg-danger-soft', title: 'text-danger' },
}

/**
 * The one status box in Settings: a gate, an untrusted folder, a malformed
 * file, a failed read. A danger notice is announced (`role=alert`).
 */
export function SettingsNotice({
  tone,
  title,
  body,
  action,
}: SettingsNoticeProps): React.JSX.Element {
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      data-notice-tone={tone}
      className={clsx('mb-4 space-y-2 rounded-lg border px-4 py-3 text-base', TONES[tone].box)}
    >
      <p className={clsx('font-medium', TONES[tone].title)}>{title}</p>
      {body && <div className="text-text-secondary space-y-2 leading-relaxed">{body}</div>}
      {action && (
        <Button size="sm" disabled={action.disabled || action.busy} onClick={action.onClick}>
          {action.busy && action.busyLabel ? action.busyLabel : action.label}
        </Button>
      )}
    </div>
  )
}
