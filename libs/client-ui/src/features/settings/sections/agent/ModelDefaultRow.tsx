import { useEffect, useMemo, useState } from 'react'
import { Button, Row, Select, TextField, type SelectOption } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { machineAgentModel } from '../../machine/machineAgentModel'
import { AGENT_ROW_TEXT } from './agentFields'
import { SourcedControl, settingSource } from './AgentFieldRow'
import type { AgentSource } from './source'

const partsOf = (model: string): [string, string] =>
  machineAgentModel(model) ?? (['', ''] as [string, string])
const pairLabel = (model: string): string => partsOf(model).join('/')

/**
 * The model new lanes start on: a catalogue choice, or any provider and model
 * id the machine has configured, which the catalogue need not list.
 */
export function ModelDefaultRow({ source }: { source: AgentSource }): React.JSX.Element {
  const { model, inheritedModel, models, catalogue, caps } = source
  const shown = model || inheritedModel
  const options = useMemo((): SelectOption[] => {
    const known = models ?? []
    return [
      ...(shown ? [] : [{ value: '', label: 'pi’s default' }]),
      ...(shown && !known.some((m) => m.value === shown)
        ? [{ value: shown, label: `${pairLabel(shown)} (not in the catalogue)` }]
        : []),
      ...known,
    ]
  }, [models, shown])
  const { title, description } = AGENT_ROW_TEXT.model
  return (
    <>
      <Row title={title} description={description}>
        <SourcedControl
          source={settingSource(model || undefined, inheritedModel || undefined)}
          title={title}
          reset={caps.clear ? () => source.setModel('') : undefined}
        >
          {models === null && !catalogue ? (
            <span className="text-text-tertiary text-sm">Loading models…</span>
          ) : (
            <Select value={shown} options={options} onChange={source.setModel} />
          )}
        </SourcedControl>
      </Row>
      {catalogue && (
        <p role="alert" className="text-warning flex items-center gap-2 py-2 text-base">
          Could not read this machine’s model catalogue. No other machine’s models are offered.
          <Button size="xs" onClick={catalogue.retry}>
            Retry model catalogue
          </Button>
        </p>
      )}
      <CustomModel value={model} onChange={source.setModel} />
    </>
  )
}

/** A provider and model id pair; it saves once both are filled. */
function CustomModel({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const [parts, setParts] = useState(() => partsOf(value))
  useEffect(() => setParts(partsOf(value)), [value])
  const complete = machineAgentModel(JSON.stringify(parts)) !== null
  const partial = !complete && parts.some((part) => part.trim())
  const commit = (index: 0 | 1, text: string): void => {
    const next: [string, string] = [...parts]
    next[index] = text
    setParts(next)
    const json = JSON.stringify(next)
    if (machineAgentModel(json) && json !== value) onChange(json)
  }
  return (
    <details className="text-text-secondary py-2 text-base">
      <TooltipSummary>Custom model</TooltipSummary>
      <p className="mt-2">
        Any model configured on this machine, including one the catalogue does not list.
      </p>
      {partial && (
        <p role="alert" className="text-warning mt-2">
          Enter both a provider id and a model id to save.
        </p>
      )}
      {(['provider', 'modelId'] as const).map((row, index) => (
        <Row
          key={row}
          title={AGENT_ROW_TEXT[row].title}
          description={AGENT_ROW_TEXT[row].description}
        >
          <TextField
            defaultValue={parts[index]!}
            onCommit={(text) => commit(index as 0 | 1, text)}
          />
        </Row>
      ))}
    </details>
  )
}
