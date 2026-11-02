import { TooltipButton } from '@/components/Tooltip'
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { TextInput } from '@/components/form'
import { contextBudgetTokens, isValidContextBudgetValue } from '@shared/context-budget'
import { formatTokens } from '@/lib/format'

/** Empty means the shared 200k default. */
const BUDGET_PRESETS = [
  {
    value: '',
    title: 'Default: 200k tokens',
    detail:
      'Every interactive session, Claude Code included, compacts once a turn ends past 200k. ' +
      'Models with a window of 200k or less keep their native limit.',
  },
  {
    value: '400k',
    title: '400k tokens',
    detail:
      'Roomier before each compaction, at roughly double the per-request cache cost once a ' +
      'session grows past 200k.',
  },
  {
    value: 'auto',
    title: 'Model maximum',
    detail:
      'pi compacts each session near its model window. On 1M-context models, most Claude models ' +
      'among them, a session can grow toward a million tokens, and every request re-reads all ' +
      'of it.',
  },
] as const

/**
 * How large a lane may grow before pi compacts it: a preset or a custom
 * value in the `@shared/context-budget` grammar. '' is the 200k default.
 */
export function ContextBudgetPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const save = (next: string): void => {
    if (next !== value) onChange(next)
  }
  const isPreset = BUDGET_PRESETS.some((p) => p.value === value)
  return (
    <>
      <h3 className="mt-3 text-lg font-medium">Context budget</h3>
      <p className="text-text-tertiary text-sm">
        How large an interactive session may grow before pi compacts it, on every provider. Smaller
        budgets reduce repeated context reads. Compaction summarizes older turns in place.
      </p>
      <div className="mt-2.5 space-y-2" role="radiogroup" aria-label="Context budget">
        {BUDGET_PRESETS.map((preset) => (
          <PresetCard
            key={preset.value || 'default'}
            preset={preset}
            selected={value === preset.value}
            onSelect={() => save(preset.value)}
          />
        ))}
        <CustomBudget value={isPreset ? null : value} onCommit={save} />
      </div>
      <p className="text-text-tertiary mt-2 text-sm">
        pi compacts before prompts and between tool cycles, reserving response headroom below this
        budget, Claude Code included. A change reaches running lanes at their next safe boundary.
        Switching a session&apos;s auto-compaction off from its ⋮ menu opts that session out. Auto
        and off remove this budget, not pi&apos;s own compaction near the window.
      </p>
    </>
  )
}

const dot = (selected: boolean): string =>
  clsx(
    'h-3 w-3 shrink-0 rounded-full border-2',
    selected ? 'border-accent bg-accent' : 'border-border-strong',
  )

function PresetCard({
  preset,
  selected,
  onSelect,
}: {
  preset: (typeof BUDGET_PRESETS)[number]
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <TooltipButton
      type="button"
      tooltip={preset.title}
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={clsx(
        'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
        selected ? 'border-accent bg-accent/5' : 'border-border hover:bg-bg-secondary',
      )}
    >
      <span className={clsx('mt-1', dot(selected))} aria-hidden />
      <span className="min-w-0">
        <span className="text-text block text-base font-medium">{preset.title}</span>
        <span className="text-text-secondary block text-sm leading-snug">{preset.detail}</span>
      </span>
    </TooltipButton>
  )
}

/** A typed budget, committed on blur or Enter; an invalid one is refused in place. */
function CustomBudget({
  value,
  onCommit,
}: {
  /** The saved custom value, or null while a preset is chosen. */
  value: string | null
  onCommit: (value: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value ?? '')
  const [error, setError] = useState(false)
  useEffect(() => {
    if (value !== null) setDraft(value)
  }, [value])
  const typed = draft.trim()
  // Preview the shorthand: bare 500 means 500k.
  const tokens = isValidContextBudgetValue(typed) ? contextBudgetTokens(typed) : null
  const commit = (): void => {
    if (typed !== '' && !isValidContextBudgetValue(typed)) return setError(true)
    onCommit(typed)
  }
  return (
    <div className="flex items-center gap-2.5 px-3 py-1">
      <span className={dot(value !== null)} aria-hidden />
      <span className="text-text text-base font-medium">Custom</span>
      <TextInput
        size="sm"
        className="w-32 font-mono"
        placeholder="e.g. 300k"
        aria-label="Custom context budget"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setError(false)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
      {error ? (
        <span className="text-warning text-sm">
          Use a budget from 100k to 1M (e.g. 300k), auto, or off.
        </span>
      ) : tokens !== null && typed !== '' ? (
        <span className="text-text-tertiary text-sm tabular-nums">
          = {formatTokens(tokens)} tokens
        </span>
      ) : null}
    </div>
  )
}
