import { useEffect, useState } from 'react'
import type { MachineAgentBehavior as Behavior } from '@shared/machine-agent-behavior'

function BehaviorNumber({
  title,
  value,
  max,
  change,
}: {
  title: string
  value?: number
  max: number
  change(value: number): void
}): React.JSX.Element {
  const [text, setText] = useState(String(value ?? ''))
  const [error, setError] = useState(false)
  useEffect(() => {
    setText(String(value ?? ''))
    setError(false)
  }, [value])
  return (
    <label className="block text-base">
      {title}
      <input
        type="number"
        value={text}
        placeholder="Inherited / pi default"
        min={0}
        max={max}
        step={1}
        className="border-border bg-bg mt-1 w-full rounded-md border p-2"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (!text) {
            setText(String(value ?? ''))
            setError(false)
            return
          }
          const n = Number(text)
          const valid = Number.isSafeInteger(n) && n >= 0 && n <= max
          setError(!valid)
          if (valid) change(n)
        }}
      />
      {error && (
        <span role="alert" className="text-danger">
          Not applied: enter a whole number between 0 and {max}.
        </span>
      )}
    </label>
  )
}
export function BehaviorToggle({
  title,
  value,
  busy,
  change,
}: {
  title: string
  value?: boolean
  busy: boolean
  change(value: boolean): void
}): React.JSX.Element {
  return (
    <label className="flex items-center justify-between gap-3 text-base">
      <span>{title}</span>
      <select
        aria-label={title}
        value={value === undefined ? '' : String(value)}
        disabled={busy}
        onChange={(e) => change(e.target.value === 'true')}
        className="border-border bg-bg rounded-md border p-2"
      >
        <option value="" disabled>
          Inherited / pi default
        </option>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
    </label>
  )
}
export function BehaviorDelivery({
  type,
  value,
  busy,
  change,
}: {
  type: 'steeringMode' | 'followUpMode'
  value?: Behavior['steeringMode']
  busy: boolean
  change(value: 'all' | 'one-at-a-time'): void
}): React.JSX.Element {
  const title = type === 'steeringMode' ? 'Steering delivery' : 'Follow-up delivery'
  return (
    <label className="flex items-center justify-between gap-3 text-base">
      <span>{title}</span>
      <select
        aria-label={title}
        disabled={busy}
        value={value ?? ''}
        onChange={(e) => change(e.target.value as 'all' | 'one-at-a-time')}
        className="border-border bg-bg rounded-md border p-2"
      >
        <option value="" disabled>
          Inherited / pi default
        </option>
        <option value="one-at-a-time">One at a time</option>
        <option value="all">All</option>
      </select>
    </label>
  )
}
export function BehaviorPolicy({
  type,
  value,
  busy,
  change,
}: {
  type: 'compaction' | 'retry'
  value: Behavior['compaction'] & Behavior['retry']
  busy: boolean
  change(value: Behavior['compaction'] & Behavior['retry']): void
}): React.JSX.Element {
  const fields =
    type === 'compaction'
      ? (['reserveTokens', 'keepRecentTokens'] as const)
      : (['maxRetries', 'baseDelayMs'] as const)
  return (
    <fieldset disabled={busy} className="border-border space-y-3 border-t pt-3">
      <legend className="text-lg font-medium">
        {type === 'compaction' ? 'Automatic compaction' : 'Automatic retry'}
      </legend>
      <BehaviorToggle
        title={type === 'compaction' ? 'Enable automatic compaction' : 'Enable automatic retry'}
        value={value?.enabled}
        busy={busy}
        change={(enabled) => change({ ...value, enabled })}
      />
      {fields.map((field) => {
        const title = {
          reserveTokens: 'Response reserve tokens',
          keepRecentTokens: 'Recent tokens to keep',
          maxRetries: 'Maximum retries',
          baseDelayMs: 'Retry base delay (ms)',
        }[field]
        return (
          <BehaviorNumber
            key={field}
            title={title}
            value={value?.[field]}
            max={field === 'maxRetries' ? 100 : 1_000_000}
            change={(n) => change({ ...value, [field]: n })}
          />
        )
      })}
    </fieldset>
  )
}
