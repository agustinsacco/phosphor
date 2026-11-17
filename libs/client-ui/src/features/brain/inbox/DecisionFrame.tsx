import { SectionLabel } from '@/features/sessions/SidebarPrimitives'

/** Keys the Inbox forwards to whichever decision is open. */
export interface DecisionKeys {
  primary?: () => void
  reject?: () => void
}

/** A decision: a header that stays, a body that scrolls, an action bar fixed at the bottom. */
export function DecisionFrame({
  label,
  eyebrow,
  title,
  subtitle,
  aside,
  children,
  bar,
}: {
  label: string
  eyebrow: string
  title: React.ReactNode
  subtitle?: React.ReactNode
  aside?: React.ReactNode
  children: React.ReactNode
  bar?: React.ReactNode
}): React.JSX.Element {
  return (
    <article aria-label={label} className="flex min-h-0 flex-1 flex-col">
      <header className="border-border flex shrink-0 flex-wrap items-start gap-x-3 gap-y-1 border-b px-5 pb-2 pt-1">
        <div className="min-w-0 flex-1">
          <SectionLabel>{eyebrow}</SectionLabel>
          <h2 className="px-2 text-xl font-semibold">{title}</h2>
          {subtitle && <p className="text-text-tertiary px-2 text-sm">{subtitle}</p>}
        </div>
        {aside && <div className="flex flex-wrap items-center gap-2 pt-3">{aside}</div>}
      </header>
      <div className="brain-scroll space-y-4 px-5 py-3">{children}</div>
      {bar}
    </article>
  )
}

/** The fixed action bar. A refusal is a sentence beside the buttons, never silence. */
export function DecisionBar({
  children,
  note,
  error,
}: {
  children: React.ReactNode
  note?: React.ReactNode
  error?: string
}): React.JSX.Element {
  return (
    <div className="brain-bar" role="group" aria-label="Decision actions">
      {children}
      <span className="min-w-4 flex-1" />
      {note && <span className="text-text-tertiary text-sm">{note}</span>}
      {error && (
        <p role="alert" className="text-danger basis-full text-sm [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
    </div>
  )
}
