import { Button } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import type { MachineAgentController } from './useMachineAgentSettings'

/** Text fallback is intentional: pi supports custom models unknown to the catalogue. */
export function HostCustomModel({
  controller,
  label,
}: {
  controller: MachineAgentController
  label: string
}): React.JSX.Element {
  const { model, setModel, catalogueFailed, retryCatalogue, busy } = controller
  let parts: [string, string] = ['', '']
  try {
    if (model) parts = JSON.parse(model) as [string, string]
  } catch {
    /* Invalid input cannot be saved. */
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
          {!controller.validModel && (
            <p role="alert" className="text-warning">
              Enter both a provider id and a model id before saving.
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
                  const next = [...parts]
                  next[index] = e.target.value
                  setModel(JSON.stringify(next))
                }}
              />
            </label>
          ))}
        </div>
      </details>
    </>
  )
}
