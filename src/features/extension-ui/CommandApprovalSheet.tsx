import { useMemo, useRef, useState, useEffect } from 'react'
import clsx from 'clsx'
import { ModalOverlay } from '@/components/Modal'
import { Button } from '@/components/form'
import { CopyButton } from '@/components/CopyButton'
import { WarningIcon } from '@/components/icons'
import { useExtensionUiStore, type PendingDialog } from '@/stores/extensionUi'
import {
  analyzeCommand,
  approvalOptions,
  focusLines,
  toCommandLines,
  type CommandApproval,
  type CommandRisk,
} from './commandApproval'

/** Above this, the command opens folded to the flagged lines. */
const FOLD_THRESHOLD = 14

/** Why an incidental match is probably not the thing to worry about. */
const CONTEXT_NOTE: Record<CommandRisk['context'], string | undefined> = {
  command: undefined,
  heredoc: 'Inside a heredoc body — written to a file here, not run.',
  quoted: 'Inside a quoted string — reads as an argument, not a command.',
}

/**
 * The dangerous-command prompt, as a review surface instead of a wall of text.
 *
 * What it replaces: the generic extension dialog put the gate's entire prose
 * — heading, command, question — into a fixed-width panel's TITLE. A one-line
 * `rm -rf` was fine; a 60-line heredoc rendered as several thousand words of
 * unwrapped bold sans-serif that ran off the top and bottom of the screen,
 * with no scroll, no monospace, and no indication of which four characters in
 * it had tripped the gate. The user's only move was to squint or deny.
 *
 * Three fixes, in order of how much they matter:
 *
 * 1. **Say what is dangerous.** The risks come first, each named and
 *    explained, and the matching text is highlighted in the command below.
 * 2. **Grade incidental matches.** A gate that fires on `rm -rf` inside a
 *    heredoc is matching text being written, not run, and the panel says so
 *    rather than leaving the user to spot it.
 * 3. **Fit on screen.** The panel is height-capped and scrolls; a long
 *    command opens folded to the flagged lines with the rest one click away.
 *
 * Denying is the safe answer, so Deny holds focus and Escape denies. Nothing
 * approves on a keypress — allowing takes a deliberate click.
 */
export function CommandApprovalSheet({
  dialog,
  approval,
}: {
  dialog: PendingDialog
  approval: CommandApproval
}): React.JSX.Element {
  const { request } = dialog
  const denyRef = useRef<HTMLButtonElement>(null)
  const [expanded, setExpanded] = useState(false)

  const { risks, lines, focus } = useMemo(() => {
    const risks = analyzeCommand(approval.command)
    const lines = toCommandLines(approval.command, risks)
    return { risks, lines, focus: focusLines(lines) }
  }, [approval.command])

  const answer = (allowed: boolean): void => {
    const store = useExtensionUiStore.getState()
    if (request.method === 'confirm') {
      store.resolveDialog(dialog, { confirmed: allowed })
      return
    }
    // A select carries the gate's own option strings; echo one back verbatim
    // rather than inventing 'Yes' — the gate compares against what it offered.
    const options = request.method === 'select' ? approvalOptions(request.options) : null
    if (!options) {
      store.resolveDialog(dialog, { cancelled: true })
      return
    }
    store.resolveDialog(dialog, { value: allowed ? options.allow : options.deny })
  }

  useEffect(() => {
    denyRef.current?.focus()
  }, [])

  const folded = lines.length > FOLD_THRESHOLD && !expanded
  const shown = folded ? lines.filter((line) => focus.has(line.number)) : lines
  const allIncidental = risks.length > 0 && risks.every((risk) => risk.context !== 'command')

  return (
    <ModalOverlay onClose={() => answer(false)} closeOnBackdrop={false}>
      <div className="border-border bg-surface-raised flex max-h-[82vh] w-[min(46rem,92vw)] flex-col overflow-hidden rounded-xl border shadow-2xl">
        <div className="border-border flex items-start gap-3 border-b px-4 py-3">
          <span
            className={clsx(
              'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
              allIncidental ? 'bg-warning/15 text-warning' : 'bg-danger-soft text-danger',
            )}
          >
            <WarningIcon size={15} />
          </span>
          <div className="min-w-0">
            <div className="text-lg font-semibold">Run this command?</div>
            <div className="text-text-tertiary mt-0.5 truncate text-sm">
              {approval.heading} · flagged by a pi extension
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="border-border flex flex-col gap-2 border-b px-4 py-3">
            {risks.length === 0 && (
              <p className="text-text-secondary text-base leading-snug">
                The extension flagged this command, but Phosphor could not identify which part it
                objected to. Read the command below before allowing it.
              </p>
            )}
            {risks.map((risk) => (
              <RiskRow key={risk.id} risk={risk} />
            ))}
            {allIncidental && (
              <p className="text-text-tertiary text-sm leading-snug">
                Every match is inside text this command writes or quotes. Nothing here runs one
                directly.
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 px-4 pb-1.5 pt-2.5">
            <span className="text-text-tertiary text-sm">
              {lines.length} {lines.length === 1 ? 'line' : 'lines'}
              {folded && ` · showing ${shown.length} around the match`}
            </span>
            <div className="flex-1" />
            {lines.length > FOLD_THRESHOLD && (
              <Button size="xs" onClick={() => setExpanded((value) => !value)}>
                {expanded ? 'Show flagged only' : 'Show all'}
              </Button>
            )}
            <CopyButton text={approval.command} size="sm" label="Copy" />
          </div>

          <div className="px-4 pb-3">
            <pre className="border-border bg-code-bg overflow-x-auto rounded-lg border py-2 font-mono text-sm leading-relaxed">
              {shown.map((line, index) => {
                const previous = shown[index - 1]
                const hidden = previous ? line.number - previous.number - 1 : 0
                return (
                  <span key={line.number} className="block">
                    {hidden > 0 && (
                      <span className="text-text-tertiary block select-none px-3 py-0.5 text-xs">
                        ⋯ {hidden} {hidden === 1 ? 'line' : 'lines'} hidden
                      </span>
                    )}
                    <span
                      className={clsx(
                        'flex gap-3 px-3',
                        // Only a real command match tints the row. Tinting an
                        // incidental one too would undo the whole distinction.
                        line.segments.some((s) => s.risk?.context === 'command') &&
                          'bg-danger-soft/40',
                      )}
                    >
                      <span className="text-text-tertiary w-6 shrink-0 select-none text-right">
                        {line.number}
                      </span>
                      <span className="min-w-0 whitespace-pre-wrap break-all">
                        {line.segments.map((segment, i) =>
                          segment.risk ? (
                            <mark
                              key={i}
                              title={segment.risk.why}
                              className={clsx(
                                'rounded px-0.5',
                                segment.risk.context === 'command'
                                  ? 'bg-danger/25 text-danger'
                                  : // Noticed, not alarming: an incidental
                                    // match is marked, never coloured like a
                                    // command that is about to run.
                                    'text-text-secondary bg-transparent underline decoration-dotted underline-offset-2',
                              )}
                            >
                              {segment.text}
                            </mark>
                          ) : (
                            <span key={i}>{segment.text}</span>
                          ),
                        )}
                      </span>
                    </span>
                  </span>
                )
              })}
            </pre>
          </div>
        </div>

        <div className="border-border flex items-center justify-end gap-2 border-t px-4 py-2.5">
          <span className="text-text-tertiary mr-auto text-sm">Escape denies</span>
          <Button ref={denyRef} onClick={() => answer(false)}>
            Deny
          </Button>
          <Button variant="danger" onClick={() => answer(true)}>
            Allow
          </Button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function RiskRow({ risk }: { risk: CommandRisk }): React.JSX.Element {
  const note = CONTEXT_NOTE[risk.context]
  return (
    <div className="flex items-start gap-2.5">
      <span
        className={clsx(
          'mt-1.5 h-2 w-2 shrink-0 rounded-full',
          risk.context !== 'command'
            ? 'bg-text-tertiary'
            : risk.severity === 'high'
              ? 'bg-danger'
              : 'bg-warning',
        )}
      />
      <div className="min-w-0">
        <code className="text-text font-mono text-base font-medium">{risk.label}</code>
        <span className="text-text-secondary ml-2 text-base leading-snug">{risk.why}</span>
        {note && <div className="text-text-tertiary text-sm leading-snug">{note}</div>}
      </div>
    </div>
  )
}
