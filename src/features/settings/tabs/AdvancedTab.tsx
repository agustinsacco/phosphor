import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Button, Row, SectionTitle, TextField } from '@/components/form'
import {
  AGENT_INSTALL_COMMANDS,
  AGENT_KINDS,
  piInstallLocation,
  type AgentKind,
  type AgentPrefs,
  type PiHealth,
} from '@shared/models'
import type { PiResources } from '@shared/models'
import { ConfigFileEditor, piConfigFile } from '../ConfigFileEditor'
import { MaintenanceSection } from './MaintenanceSection'

/** Which agent sessions run on, its health, discovered pi resources, and raw config editing. */

const AGENT_LABELS: Record<AgentKind, string> = {
  pi: 'pi',
  omp: 'omp (oh-my-pi)',
}

export function AdvancedTab(): React.JSX.Element {
  const [health, setHealth] = useState<PiHealth | null>(null)
  const [agent, setAgent] = useState<AgentPrefs | null>(null)
  const [resources, setResources] = useState<PiResources | null>(null)
  const [editing, setEditing] = useState<'settings' | 'models' | null>(null)

  useEffect(() => {
    void window.phosphor.invoke('pi:health').then(setHealth)
    void window.phosphor.invoke('app:getPrefs').then((prefs) => setAgent(prefs.agent))
    void window.phosphor.invoke('pi:listResources').then(setResources)
  }, [])

  // Health, the `/` menu, the model catalogue and the sidebar's session
  // folders all follow the agent. Main re-points its caches; a reload makes
  // every screen re-derive rather than each one learning to listen. Live
  // sessions keep running on the agent they started with and are re-adopted.
  const chooseAgent = async (next: AgentPrefs): Promise<void> => {
    setAgent(await window.phosphor.invoke('app:setAgent', next))
    window.location.reload()
  }

  return (
    <div>
      <SectionTitle>Advanced</SectionTitle>

      <Row
        title="Agent"
        description="The coding agent new sessions run on. Running sessions keep theirs."
      >
        <select
          aria-label="Agent"
          value={agent?.kind ?? 'pi'}
          disabled={!agent}
          onChange={(e) => {
            if (agent) void chooseAgent({ ...agent, kind: e.target.value as AgentKind })
          }}
          className="border-border bg-surface text-text rounded-lg border px-2.5 py-1.5 text-base outline-none"
        >
          {AGENT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {AGENT_LABELS[kind]}
            </option>
          ))}
        </select>
      </Row>
      {agent && (
        <Row
          title={`${agent.kind} binary`}
          description={`Leave empty to find ${agent.kind} on your login shell's PATH. Install: ${AGENT_INSTALL_COMMANDS[agent.kind]}`}
        >
          <TextField
            defaultValue={agent.binaryPaths[agent.kind]}
            placeholder="found on PATH"
            onCommit={(path) =>
              void chooseAgent({
                ...agent,
                binaryPaths: { ...agent.binaryPaths, [agent.kind]: path },
              })
            }
          />
        </Row>
      )}

      <Row
        title={`${health?.agent ?? 'agent'} health`}
        description={
          health
            ? [
                piInstallLocation(health) ?? 'not found',
                health.minVersion ? `minimum supported ${health.minVersion}` : null,
              ]
                .filter(Boolean)
                .join(' — ')
            : 'checking…'
        }
      >
        <span
          className={clsx(
            'rounded-md px-2 py-1 font-mono text-sm font-medium',
            health?.ok ? 'bg-success/15 text-success' : 'bg-danger-soft text-danger',
          )}
        >
          {health ? (health.ok ? `v${health.version}` : (health.reason ?? 'error')) : '…'}
        </span>
      </Row>

      <Row
        title="pi settings.json"
        description="Raw editor for ~/.pi/agent/settings.json. Restart sessions to apply."
      >
        <Button onClick={() => setEditing('settings')}>Edit…</Button>
      </Row>
      <Row
        title="pi models.json"
        description="Custom providers and models (local endpoints live here)."
      >
        <Button onClick={() => setEditing('models')}>Edit…</Button>
      </Row>

      <MaintenanceSection />

      <SectionTitle small>
        Local pi resources (loose files — packages are in the Extensions tab; skills have their own
        page: sidebar → Skills)
      </SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        {(['extensions', 'prompts', 'themes'] as const).map((kind) => (
          <div key={kind} className="border-border bg-surface rounded-xl border p-3">
            <div className="text-text-tertiary text-xs font-semibold font-mono uppercase tracking-wider">
              {kind}
            </div>
            <div className="mt-1.5 space-y-0.5">
              {(resources?.[kind] ?? []).slice(0, 8).map((name) => (
                <div key={name} className="truncate font-mono text-sm">
                  {name}
                </div>
              ))}
              {resources && resources[kind].length === 0 && (
                <div className="text-text-tertiary text-sm">none</div>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="text-text-tertiary mt-3 text-sm">
        auth.json is never read or displayed by Phosphor.
      </p>

      {editing && (
        <ConfigFileEditor source={piConfigFile(editing)} onClose={() => setEditing(null)} />
      )}
    </div>
  )
}
