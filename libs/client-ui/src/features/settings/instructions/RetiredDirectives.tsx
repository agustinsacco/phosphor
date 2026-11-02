import { useState } from 'react'
import { Button } from '@/components/form'
import { CopyButton } from '@/components/CopyButton'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { errorText } from '@shared/errors'

/**
 * Free text from the old "Your own text" directive that could not move into
 * global instructions by itself: a project's override (a repository's
 * AGENTS.md belongs to the user, so Phosphor never writes it) or global text
 * the instructions file refused. Lanes no longer receive it. It stays here
 * until the user copies it where it belongs and dismisses it.
 */
export function RetiredDirectives({
  retired,
  onDismissed,
}: {
  retired: Record<string, string>
  onDismissed: () => void
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const entries = Object.entries(retired)
  if (entries.length === 0) return null

  const dismiss = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.phosphor.invoke('app:clearRetiredDirectives')
      onDismissed()
    } catch (error) {
      useExtensionUiStore.getState().pushToast(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="note"
      aria-label="Retired directive text"
      className="border-warning/40 bg-bg-secondary flex flex-col gap-2 rounded-lg border p-3 text-sm"
    >
      <p className="text-text-secondary leading-relaxed">
        &ldquo;Your own text&rdquo; is now global instructions. This text could not move there by
        itself, and lanes no longer receive it. Copy it into global instructions or the
        project&rsquo;s own AGENTS.md, then dismiss it.
      </p>
      {entries.map(([path, text]) => (
        <div key={path} className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span
              className="text-text-tertiary flex-1 truncate font-mono text-xs"
              data-tooltip={path || undefined}
            >
              {path || 'Global (the instructions file refused it)'}
            </span>
            <CopyButton text={text} label="Copy" />
          </div>
          <div className="border-border bg-bg text-text-secondary max-h-40 overflow-y-auto rounded-md border px-2.5 py-2 font-mono text-xs whitespace-pre-wrap">
            {text}
          </div>
        </div>
      ))}
      <Button size="sm" className="self-start" disabled={busy} onClick={() => void dismiss()}>
        Dismiss
      </Button>
    </div>
  )
}
