import {
  Button,
  NumberField,
  Row,
  Select,
  SourceBadge,
  Toggle,
  type SelectOption,
  type SettingSource,
} from '@/components/form'
import {
  AGENT_FIELDS,
  agentFieldValue,
  type AgentField,
  type AgentFieldKey,
} from '@shared/machine-agent-behavior'
import { ALL_THINKING_LEVELS } from '@shared/thinking'
import type { AgentSource } from './source'
import { AGENT_FIELD_TEXT } from './agentFields'

const MODES: readonly SelectOption[] = [
  { value: 'one-at-a-time', label: 'One at a time' },
  { value: 'all', label: 'All' },
]
const LEVELS: readonly SelectOption[] = ALL_THINKING_LEVELS.map((level) => ({
  value: level,
  label: level,
}))

/**
 * The choice that leaves a field unset, named by what it then falls back to:
 * the machine's value, else pi's default. Offered while nothing is set here,
 * so every concrete value is a change, and as Reset where clearing works.
 */
export const unsetChoice = (inherited: string | undefined, piDefault?: string): SelectOption => ({
  value: '',
  label:
    inherited !== undefined
      ? `Machine (${inherited})`
      : piDefault
        ? `pi default (${piDefault})`
        : 'pi default',
})

/** Which scope a shown value comes from: this one, the machine's, or pi itself. */
export function settingSource(own: unknown, inherited: unknown): SettingSource {
  if (own !== undefined) return 'set-here'
  return inherited !== undefined ? 'inherited' : 'pi-default'
}

/** A row's trailing controls: where the value comes from, the control, and Reset. */
export function SourcedControl({
  source,
  title,
  reset,
  children,
}: {
  source: SettingSource
  title: string
  /** Shown only for a value set here, on a machine that can clear it. */
  reset?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 max-w-full items-center gap-2">
      <SourceBadge source={source} />
      {children}
      {reset && source === 'set-here' && (
        <Button size="xs" aria-label={`Reset ${title}`} onClick={reset}>
          Reset
        </Button>
      )}
    </span>
  )
}

/**
 * One pi setting: the value this scope sets, else the machine's (folder
 * scope), else pi's own default, with a badge that says which.
 */
export function AgentFieldRow({
  field: key,
  source,
}: {
  field: AgentFieldKey
  source: AgentSource
}): React.JSX.Element | null {
  if (!source.fields.includes(key)) return null
  const field: AgentField = AGENT_FIELDS[key]
  const { title, description } = AGENT_FIELD_TEXT[key]
  const own = agentFieldValue(source.own, field.path)
  const inherited = source.inherited ? agentFieldValue(source.inherited, field.path) : undefined
  const shown = own ?? inherited ?? field.piDefault
  const set = (value: unknown) => source.setField(key, value)
  const choices = field.kind === 'mode' ? MODES : LEVELS
  const labelOf = (value: unknown): string =>
    choices.find((choice) => choice.value === value)?.label ?? String(value)
  const unset =
    own === undefined || source.caps.clear
      ? [
          unsetChoice(
            inherited === undefined ? undefined : labelOf(inherited),
            labelOf(field.piDefault),
          ),
        ]
      : []
  return (
    <Row title={title} description={description}>
      <SourcedControl
        source={settingSource(own, inherited)}
        title={title}
        reset={source.caps.clear ? () => set(undefined) : undefined}
      >
        {field.kind === 'bool' ? (
          <Toggle on={shown === true} onChange={set} />
        ) : field.kind === 'int' ? (
          <NumberField
            value={Number(shown)}
            min={field.min ?? 0}
            max={field.max ?? 0}
            step={field.step ?? 1}
            onChange={set}
          />
        ) : (
          <Select
            value={own === undefined ? '' : String(own)}
            options={[...unset, ...choices]}
            onChange={(value) => set(value === '' ? undefined : value)}
          />
        )}
      </SourcedControl>
    </Row>
  )
}
