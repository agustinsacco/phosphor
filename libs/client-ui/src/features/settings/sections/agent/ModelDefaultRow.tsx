import { useEffect, useMemo, useState } from 'react'
import { Button, Row, Select, TextInput, type SelectOption } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { machineAgentModel } from '../../machine/machineAgentModel'
import { AGENT_ROW_TEXT } from './agentFields'
import { SourcedControl, settingSource, unsetChoice } from './AgentFieldRow'
import type { AgentSource } from './source'

/** A model value's two ids; one is '' where the file sets only the other. */
function partsOf(model: string): [string, string] {
  try {
    const parts: unknown = JSON.parse(model)
    if (Array.isArray(parts) && parts.length === 2 && parts.every((p) => typeof p === 'string'))
      return parts as [string, string]
  } catch {
    // '' is no model.
  }
  return ['', '']
}
const pairLabel = (model: string): string => {
  const [provider, id] = partsOf(model)
  if (!provider) return `${id} (no provider id)`
  return id ? `${provider}/${id}` : `${provider} (no model id)`
}
const complete = (model: string): boolean => machineAgentModel(model) !== null

/**
 * The model new lanes start on: a catalogue choice, or any provider and model
 * id the machine has configured, which the catalogue need not list.
 */
export function ModelDefaultRow({ source }: { source: AgentSource }): React.JSX.Element {
  const { model, inheritedModel, models, catalogue, caps } = source
  const options = useMemo((): SelectOption[] => {
    const known = models ?? []
    const listed = (pair: string): boolean => known.some((m) => m.value === pair)
    const labelOf = (pair: string): string =>
      known.find((m) => m.value === pair)?.label ?? pairLabel(pair)
    // An inherited pair with one id missing is not offered: choosing it would write half a pair.
    const unlisted = [...new Set([model, inheritedModel])].filter(
      (m) => m && !listed(m) && (m === model || complete(m)),
    )
    return [
      ...(!model || caps.clear
        ? [unsetChoice(inheritedModel ? labelOf(inheritedModel) : undefined)]
        : []),
      ...unlisted.map((m) => ({
        value: m,
        label: complete(m) ? `${pairLabel(m)} (not in the catalogue)` : pairLabel(m),
      })),
      ...known,
    ]
  }, [models, model, inheritedModel, caps.clear])
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
            <Select value={model} options={options} onChange={source.setModel} />
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

/**
 * A provider and model id pair. It saves whole, once both ids are filled and
 * the user presses Enter or Use, or leaves the disclosure: moving from one id
 * to the other saves nothing, so no half-edited pair reaches the machine.
 */
function CustomModel({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const [parts, setParts] = useState(() => partsOf(value))
  useEffect(() => setParts(partsOf(value)), [value])
  const json = JSON.stringify(parts.map((part) => part.trim()))
  const complete = machineAgentModel(json) !== null
  const partial = !complete && parts.some((part) => part.trim())
  const commit = (): void => {
    if (complete && json !== value) onChange(json)
  }
  return (
    <details
      className="text-text-secondary py-2 text-base"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commit()
      }}
    >
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
          <TextInput
            aria-label={AGENT_ROW_TEXT[row].title}
            value={parts[index]}
            onChange={(event) =>
              setParts(
                index === 0 ? [event.target.value, parts[1]] : [parts[0], event.target.value],
              )
            }
            onKeyDown={(event) => event.key === 'Enter' && commit()}
            className="w-56"
          />
        </Row>
      ))}
      <Button size="sm" disabled={!complete || json === value} onClick={commit}>
        Use
      </Button>
    </details>
  )
}
