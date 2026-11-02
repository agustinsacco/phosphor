import { useEffect, useState } from 'react'
import { isValidContextBudgetValue } from '@shared/context-budget'
import type { ThinkingLevel } from '@shared/rpc'
import { Card, Skeleton } from './MachineUi'

import type { MachineAgentController } from './useMachineAgentSettings'
import { HostCustomModel } from './HostCustomModel'
export function MachineModelDefaults({
  controller,
  label,
}: {
  controller: MachineAgentController
  label: string
}): React.JSX.Element {
  const {
    state,
    models,
    catalogueFailed,
    model,
    thinking,
    setModel,
    setThinking,
    busy,
    draft,
    knownModel,
  } = controller
  return (
    <Card title="New lane defaults">
      <div className="space-y-4">
        <label className="block text-base">
          Provider and model
          {models === null && !catalogueFailed ? (
            <Skeleton className="mt-2 h-8 w-full" />
          ) : (
            <select
              aria-label="Default Host model"
              value={model}
              disabled={busy || catalogueFailed}
              onChange={(e) => setModel(e.target.value)}
              className="border-border bg-bg mt-1 w-full rounded-md border p-2"
            >
              {/* pi has no "unset" through this form: the empty choice exists only until a model is saved. */}
              {!draft.base.model && (
                <option value="">
                  {state?.defaultModel
                    ? `${state?.defaultProvider ?? 'provider'}/${state?.defaultModel} · choose from catalogue to change`
                    : 'Use pi’s existing default; choose a model to change'}
                </option>
              )}
              {model && !knownModel && (
                <option value={model}>Saved model is unavailable in this catalogue</option>
              )}
              {models?.map((m) => (
                <option key={`${m.provider}/${m.id}`} value={JSON.stringify([m.provider, m.id])}>
                  {m.name} · {m.provider}
                </option>
              ))}
            </select>
          )}
        </label>
        <HostCustomModel controller={controller} label={label} />
        <label className="block text-base">
          Thinking level
          <select
            aria-label="Default Host thinking"
            value={thinking}
            disabled={busy}
            onChange={(e) => setThinking(e.target.value as ThinkingLevel)}
            className="border-border bg-bg mt-1 w-full rounded-md border p-2"
          >
            {['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => (
              <option key={level}>{level}</option>
            ))}
          </select>
        </label>
      </div>
    </Card>
  )
}
export function MachineHostPolicy({
  controller,
  label,
}: {
  controller: MachineAgentController
  label: string
}): React.JSX.Element {
  const { budget, naming, setBudget, setNaming, busy } = controller
  const [text, setText] = useState(budget)
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    setText(budget)
    setInvalid(false)
  }, [budget])
  const commit = () => {
    const next = text.trim()
    if (next === budget) return
    if (next !== '' && !isValidContextBudgetValue(next)) {
      setInvalid(true)
      return
    }
    setBudget(next)
  }
  return (
    <Card title="Host policy">
      <div className="space-y-4">
        <label className="block text-base">
          Context budget
          <input
            aria-label="Host context budget"
            aria-invalid={invalid || undefined}
            value={text}
            disabled={busy}
            placeholder="200k"
            onChange={(e) => {
              setText(e.target.value)
              setInvalid(false)
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
            }}
            className="border-border bg-bg mt-1 w-full rounded-md border p-2"
          />
          {invalid ? (
            <span role="alert" className="text-danger mt-1 block text-sm">
              Not saved: use a budget from 100k to 1M (e.g. 300k), auto, or off.
            </span>
          ) : (
            <span className="text-text-secondary mt-1 block text-sm">
              Default 200k. One budget for native and Claude Code lanes. Automatic compaction keeps
              response headroom.
            </span>
          )}
        </label>
        <label className="flex items-center gap-2 text-base">
          <input
            type="checkbox"
            disabled={busy}
            checked={naming}
            onChange={(e) => setNaming(e.target.checked)}
          />
          Automatically name new lanes
        </label>
        <p className="text-text-tertiary text-sm">
          The context budget applies to the next lane without a restart. Automatic naming applies
          after you restart the service on {label}; saving never restarts it or stops lanes.
        </p>
      </div>
    </Card>
  )
}
