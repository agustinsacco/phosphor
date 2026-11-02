import { Row, SaveStatus, SectionTitle, SettingsNotice, Toggle } from '@/components/form'
import { AGENT_GROUP_FIELDS, AGENT_GROUPS, AGENT_ROW_TEXT } from './agentFields'
import { AgentDirectives } from './AgentDirectives'
import { AgentFieldRow } from './AgentFieldRow'
import { ContextBudgetPicker } from './ContextBudgetPicker'
import { ModelDefaultRow } from './ModelDefaultRow'
import type { AgentSource } from './source'

/**
 * Settings → Agent on every machine: the pi settings new lanes start with,
 * Phosphor's machine-wide policy, and the instructions and directives lanes
 * are given. The machine's adapter (`useLocalAgent`, `useHostAgent`) supplies
 * the data; this view never asks which machine it is on.
 */
export function AgentSettingsView({ source }: { source: AgentSource }): React.JSX.Element {
  const { status, notice, save, blocked, policy } = source
  return (
    <div>
      <SectionTitle>Agent defaults</SectionTitle>
      <p className="text-text-tertiary -mt-2 mb-4 text-base">
        pi&apos;s settings for new lanes; a lane&apos;s own choices take precedence. Changes save as
        you make them.
      </p>
      {notice && <SettingsNotice {...notice} />}
      {save && <SaveStatus state={save} />}
      {status === 'loading' ? null : typeof status === 'object' ? (
        <SettingsNotice
          tone="danger"
          title="Could not read the agent settings."
          body={status.error}
          action={{ label: 'Try again', onClick: status.retry }}
        />
      ) : (
        <>
          <Group id="lanes">
            <fieldset disabled={blocked} className="contents">
              <ModelDefaultRow source={source} />
              <AgentFieldRow field="defaultThinkingLevel" source={source} />
            </fieldset>
            {policy && (
              <Row
                title={AGENT_ROW_TEXT.autoName.title}
                description={autoNameText(policy.autoNameNote)}
              >
                <Toggle on={policy.autoName} onChange={policy.setAutoName} />
              </Row>
            )}
          </Group>
          <PiGroup id="behaviour" source={source} />
          {(policy || source.fields.includes('compaction.enabled')) && (
            <Group id="compaction">
              <fieldset disabled={blocked} className="contents">
                <AgentFieldRow field="compaction.enabled" source={source} />
              </fieldset>
              {policy && <ContextBudgetPicker value={policy.budget} onChange={policy.setBudget} />}
              <fieldset disabled={blocked} className="contents">
                {AGENT_GROUP_FIELDS.compaction.map((field) => (
                  <AgentFieldRow key={field} field={field} source={source} />
                ))}
              </fieldset>
            </Group>
          )}
          <PiGroup id="retry" source={source} />
          {source.folder && (
            <p className="text-text-tertiary mt-6 text-sm">
              The context budget, automatic naming, global instructions
              {source.caps.folderDirectives ? '' : ' and directives'} apply to the whole machine:
              choose Machine in the scope line to change them.
            </p>
          )}
          {(source.directives || source.instructions) && (
            <Group id="directives">
              <AgentDirectives source={source} />
            </Group>
          )}
        </>
      )}
    </div>
  )
}

const autoNameText = (note?: string): string =>
  note ? `${AGENT_ROW_TEXT.autoName.description} ${note}` : AGENT_ROW_TEXT.autoName.description

function Group({
  id,
  children,
}: {
  id: keyof typeof AGENT_GROUPS
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={AGENT_GROUPS[id].title}>
      <SectionTitle small>{AGENT_GROUPS[id].title}</SectionTitle>
      {children}
    </section>
  )
}

/** A group of pi settings fields, shown when the machine edits any of them. */
function PiGroup({
  id,
  source,
}: {
  id: 'behaviour' | 'retry'
  source: AgentSource
}): React.JSX.Element | null {
  const fields = AGENT_GROUP_FIELDS[id].filter((field) => source.fields.includes(field))
  if (fields.length === 0) return null
  return (
    <Group id={id}>
      <fieldset disabled={source.blocked} className="contents">
        {fields.map((field) => (
          <AgentFieldRow key={field} field={field} source={source} />
        ))}
      </fieldset>
    </Group>
  )
}
