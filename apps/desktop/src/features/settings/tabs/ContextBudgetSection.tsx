import { TooltipButton } from '@/components/Tooltip'
import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { SectionTitle, TextInput } from '@/components/form'
import { contextBudgetTokens, isValidContextBudgetValue } from '@shared/context-budget'
import { formatTokens } from '@/lib/format'
import { useContextBudgetStore } from '@/stores/contextBudgetPref'

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

/** A Phosphor preference, outside the Agent tab's pi-settings scope. */
export function ContextBudgetSection(): React.JSX.Element {
  const [value, setValue] = useState('')
  const [customDraft, setCustomDraft] = useState('')
  const [customError, setCustomError] = useState(false)

  useEffect(() => {
    void window.phosphor.invoke('app:getPrefs').then((prefs) => {
      const stored = prefs.contextBudget ?? ''
      setValue(stored)
      if (!BUDGET_PRESETS.some((p) => p.value === stored)) setCustomDraft(stored)
    })
  }, [])

  const save = useCallback((next: string): void => {
    setValue(next)
    setCustomError(false)
    useContextBudgetStore.getState().applyContextBudget(next)
    void window.phosphor.invoke('app:setContextBudget', next)
  }, [])

  // Preview the shorthand: bare 500 means 500k.
  const customTokens = isValidContextBudgetValue(customDraft.trim())
    ? contextBudgetTokens(customDraft.trim())
    : null

  const commitCustom = useCallback((): void => {
    const draft = customDraft.trim()
    if (draft === '') {
      save('')
      return
    }
    if (!isValidContextBudgetValue(draft)) {
      setCustomError(true)
      return
    }
    save(draft)
  }, [customDraft, save])

  const isPreset = BUDGET_PRESETS.some((p) => p.value === value)

  return (
    <>
      <SectionTitle small>Context budget</SectionTitle>
      <p className="text-text-secondary text-base">
        How large an interactive session may grow before pi compacts it, on every provider. Smaller
        budgets reduce repeated context reads. Compaction summarizes older turns in place.
      </p>
      <div className="mt-2.5 space-y-2" role="radiogroup" aria-label="Context budget">
        {BUDGET_PRESETS.map((preset) => {
          const selected = value === preset.value
          return (
            <TooltipButton
              key={preset.value || 'default'}
              type="button"
              tooltip={preset.title}
              role="radio"
              aria-checked={selected}
              onClick={() => save(preset.value)}
              className={clsx(
                'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
                selected ? 'border-accent bg-accent/5' : 'border-border hover:bg-bg-secondary',
              )}
            >
              <span
                className={clsx(
                  'mt-1 h-3 w-3 shrink-0 rounded-full border-2',
                  selected ? 'border-accent bg-accent' : 'border-border-strong',
                )}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="text-text block text-base font-medium">{preset.title}</span>
                <span className="text-text-secondary block text-sm leading-snug">
                  {preset.detail}
                </span>
              </span>
            </TooltipButton>
          )
        })}
        <div className="flex items-center gap-2.5 px-3 py-1">
          <span
            className={clsx(
              'h-3 w-3 shrink-0 rounded-full border-2',
              !isPreset ? 'border-accent bg-accent' : 'border-border-strong',
            )}
            aria-hidden
          />
          <span className="text-text text-base font-medium">Custom</span>
          <TextInput
            size="sm"
            className="w-32 font-mono"
            placeholder="e.g. 300k"
            aria-label="Custom context budget"
            value={customDraft}
            onChange={(e) => {
              setCustomDraft(e.target.value)
              setCustomError(false)
            }}
            onBlur={commitCustom}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitCustom()
            }}
          />
          {customError ? (
            <span className="text-warning text-sm">
              Use a budget from 100k to 1M (e.g. 300k), auto, or off.
            </span>
          ) : customTokens !== null && customDraft.trim() !== '' ? (
            <span className="text-text-tertiary text-sm tabular-nums">
              = {formatTokens(customTokens)} tokens
            </span>
          ) : null}
        </div>
      </div>
      <p className="text-text-tertiary mt-2 text-sm">
        pi compacts before prompts and between tool cycles, reserving response headroom below this
        budget, Claude Code included. Changes apply at the next safe boundary. Switching a
        session&apos;s auto-compaction off from its ⋮ menu opts that session out. Auto and off
        remove this budget, not pi&apos;s own compaction near the window.
      </p>
    </>
  )
}
