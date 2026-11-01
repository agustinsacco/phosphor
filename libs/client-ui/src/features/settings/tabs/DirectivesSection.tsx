import { TooltipButton } from '@/components/Tooltip'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { DEFAULT_AGENT_DIRECTIVES } from '@shared/models'
import type { AgentDirectivePrefs } from '@shared/models'
import { Button, Row, SectionTitle } from '@/components/form'
import { useSettingsWorkspace } from '../SettingsMachineScope'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useAccount } from '../useAccount'
import { errorText } from '@shared/errors'
import { localMachineLabel } from '@/features/machines/machinePresentation'
import { EditInstructions } from '../instructions/EditInstructions'
import { localInstructions } from '../instructions/instructionsSource'
import { DirectiveToggles } from './DirectiveToggles'
import { RetiredDirectives } from '../instructions/RetiredDirectives'

/**
 * What a lane on this computer is told beyond pi's own prompt.
 *
 * Two layers, owned differently:
 *
 * 1. Global instructions are the user's words: pi's global context file in
 *    this computer's agent directory, the same one pi in a terminal reads.
 *    Phosphor edits it in place and adds no file of its own. Every lane reads
 *    it per request, so a save reaches running lanes at their next message.
 * 2. The directive blocks are Phosphor's words with per-lane facts in them,
 *    so they are switches, and the composed result is shown exactly as the
 *    session service builds it. They are fixed when a lane starts.
 */
export function DirectivesSection(): React.JSX.Element {
  const workspace = useSettingsWorkspace()
  const { view } = useAccount()
  const signedIn = view?.account.status === 'signed-in'
  const [scope, setScope] = useState<'global' | 'project'>('global')
  const [global, setGlobal] = useState<AgentDirectivePrefs>(DEFAULT_AGENT_DIRECTIVES)
  const [byProject, setByProject] = useState<Record<string, AgentDirectivePrefs>>({})
  const [retired, setRetired] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState(false)
  const machine = localMachineLabel(window.phosphor.platform)
  const source = useMemo(() => localInstructions(machine), [machine])

  const reload = useCallback((): void => {
    void window.phosphor.invoke('app:getPrefs').then((prefs) => {
      setGlobal(prefs.agentDirectives)
      setByProject(prefs.agentDirectivesByProject)
      setRetired(prefs.retiredDirectives)
    })
  }, [])

  useEffect(() => reload(), [reload])

  const override = workspace ? byProject[workspace] : undefined
  const shown = scope === 'project' ? (override ?? global) : global
  const usingOverride = scope === 'project' && override !== undefined

  const save = async (next: AgentDirectivePrefs | null): Promise<void> => {
    try {
      await window.phosphor.invoke(
        'app:setAgentDirectives',
        next,
        scope === 'project' ? (workspace ?? undefined) : undefined,
      )
      useExtensionUiStore.getState().pushToast('Saved. Applies to newly started lanes.', 'info')
      reload()
    } catch (error) {
      useExtensionUiStore.getState().pushToast(errorText(error), 'error')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <SectionTitle>Directives</SectionTitle>

      <Row
        title="Global instructions"
        description={`Your own instructions for every agent on ${machine}: pi's global AGENTS.md, which Phosphor lanes, routines, sub-agents and pi in a terminal all load. Running lanes use a save from their next message.`}
      >
        <Button size="sm" onClick={() => setEditing(true)}>
          Edit instructions
        </Button>
      </Row>
      <RetiredDirectives retired={retired} onDismissed={reload} />

      <div className="text-text-secondary text-sm leading-relaxed">
        What Phosphor appends to every lane&rsquo;s system prompt, in this order. These instructions
        guide the agent; tool guards provide enforcement. Changes apply to newly started lanes.
      </div>

      <div className="flex items-center gap-1.5">
        {(['global', 'project'] as const).map((option) => (
          <TooltipButton
            key={option}
            onClick={() => setScope(option)}
            disabled={option === 'project' && !workspace}
            className={
              scope === option
                ? 'border-accent bg-accent-soft text-accent rounded-md border px-2.5 py-1 font-mono text-xs uppercase'
                : 'border-border text-text-secondary hover:border-border-strong disabled:opacity-40 rounded-md border px-2.5 py-1 font-mono text-xs uppercase'
            }
          >
            {option}
          </TooltipButton>
        ))}
        {scope === 'project' && (
          <span className="text-text-tertiary ml-1 font-mono text-xs">
            {usingOverride ? 'overriding the global default' : 'inheriting the global default'}
          </span>
        )}
      </div>

      <DirectiveToggles
        value={shown}
        machine={{ kind: 'desktop', signedIn }}
        onChange={(patch) => void save({ ...shown, ...patch })}
      />

      {usingOverride && (
        <TooltipButton
          onClick={() => void save(null)}
          className="border-border text-text-secondary hover:border-border-strong self-start rounded-md border px-2.5 py-1 text-sm"
        >
          Clear this project&rsquo;s override
        </TooltipButton>
      )}
      {editing && <EditInstructions source={source} onClose={() => setEditing(false)} />}
    </div>
  )
}
