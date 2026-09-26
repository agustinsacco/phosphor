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
      'Interactive sessions share a 200k budget. Smaller models keep their native limit; ' +
      'pi-owned sessions are checked after each turn settles.',
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
      'Each provider decides: pi compacts near the model window, the Claude Code CLI at its own ' +
      'limit. On 1M-context models a session can grow toward a million tokens, and every request ' +
      're-reads all of it.',
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

  // Preview the CLI shorthand: bare 500 means 500k.
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
        The context budget for interactive sessions on every provider. Smaller budgets reduce
        repeated context reads. Compaction summarizes older turns in place.
      </p>
      <div className="mt-2.5 space-y-2" role="radiogroup" aria-label="Context budget">
        {BUDGET_PRESETS.map((preset) => {
          const selected = value === preset.value
          return (
            <button
              key={preset.value || 'default'}
              type="button"
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
            </button>
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
        On the Claude Code provider the CLI compacts its own session at this budget (pi-claude-cli
        0.5.0 or newer), read when the session starts. Everywhere else pi compacts when a turn ends
        over it, running sessions included; switching a session&apos;s auto-compaction off from its
        ⋮ menu opts that session out. Auto and off remove this budget, not native compaction. The
        meter shows the current setting; restart Claude sessions to apply changes.
      </p>
    </>
  )
}
