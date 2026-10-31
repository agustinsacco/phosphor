import { useEffect, useState } from 'react'
import { Button } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { machineAgentModel } from './machineAgentModel'
import type { MachineAgentController } from './useMachineAgentSettings'

const partsOf = (model: string): [string, string] =>
  machineAgentModel(model) ?? (['', ''] as [string, string])

/**
 * Text fallback is intentional: pi supports custom models unknown to the
 * catalogue. The pair saves once both ids are filled and a field is left.
 */
export function HostCustomModel({
  controller,
  label,
}: {
  controller: MachineAgentController
  label: string
}): React.JSX.Element {
  const { model, setModel, catalogueFailed, retryCatalogue, busy } = controller
  const [parts, setParts] = useState(() => partsOf(model))
  useEffect(() => setParts(partsOf(model)), [model])
  const next = JSON.stringify(parts)
  const complete = machineAgentModel(next) !== null
  const partial = !complete && parts.some((part) => part.trim())
  const commit = () => {
    if (complete && next !== model) setModel(next)
  }
  return (
    <>
      <div>
        {catalogueFailed && (
          <>
            <p role="alert" className="text-warning text-base">
              Could not read {label}’s model catalogue. No local models are substituted.
            </p>
            <Button size="xs" disabled={busy} onClick={retryCatalogue}>
              Retry {label} model catalogue
            </Button>
          </>
        )}
      </div>
      <details className="text-text-secondary text-base">
        <TooltipSummary>Custom model / catalogue recovery</TooltipSummary>
        <div className="mt-3 space-y-3">
          {partial && (
            <p role="alert" className="text-warning">
              Enter both a provider id and a model id to save.
            </p>
          )}
          <p>
            Use a provider and model id configured on {label}. This does not substitute this
            computer’s catalogue.
          </p>
          {(['Provider id', 'Model id'] as const).map((title, index) => (
            <label key={title} className="block">
              {title}
              <input
                aria-label={`Custom Host ${title.toLowerCase()}`}
                value={parts[index]}
                maxLength={200}
                disabled={busy}
                className="border-border bg-bg mt-1 w-full rounded-md border p-2"
                onChange={(e) => {
                  const edited: [string, string] = [...parts]
                  edited[index] = e.target.value
                  setParts(edited)
                }}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit()
                }}
              />
            </label>
          ))}
        </div>
      </details>
    </>
  )
}
