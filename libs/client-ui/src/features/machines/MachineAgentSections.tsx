import { Button } from '@/components/form'
import { promptChoice } from '@/stores/prompt'
import type { ThinkingLevel } from '@shared/rpc'
import { Card, Skeleton } from './MachineUi'
import type { HostSettingsState } from './useHostSettings'

import type { MachineAgentController } from './useMachineAgentSettings'
import { HostCustomModel } from './HostCustomModel'
export function MachineModelDefaults({
  controller,
  label,
  settings,
}: {
  controller: MachineAgentController
  label: string
  settings: HostSettingsState
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
    saveModel,
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
              <option value="">
                {state?.defaultModel
                  ? `${state?.defaultProvider ?? 'provider'}/${state?.defaultModel} · choose from catalogue to change`
                  : 'Use pi’s existing default; choose a model to change'}
              </option>
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
        <div className="flex justify-end">
          <Button disabled={busy || !controller.validModel} onClick={() => void saveModel()}>
            {settings.saving ? 'Saving…' : 'Review model defaults'}
          </Button>
        </div>
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
  const { draft, budget, naming, setBudget, setNaming, busy } = controller
  return (
    <Card title="Host policy" aside="Requires a Host service restart">
      <div className="space-y-4">
        <label className="block text-base">
          Context budget
          <input
            aria-label="Host context budget"
            value={budget}
            disabled={busy}
            onChange={(e) => setBudget(e.target.value)}
            className="border-border bg-bg mt-1 w-full rounded-md border p-2"
          />
          <span className="text-text-secondary mt-1 block text-sm">
            Default 200k. One budget for native and Claude Code lanes. Automatic compaction keeps
            response headroom.
          </span>
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
        <Button
          disabled={busy}
          onClick={() =>
            void (async () => {
              if (
                (await promptChoice({
                  title: `Save Host policy on ${label}?`,
                  message:
                    'This writes the Host configuration. It does not restart the service or stop lanes. The saved policy takes effect after an explicit Host service restart.',
                  choices: [{ value: 'save', label: 'Save policy', primary: true }],
                })) === 'save'
              )
                await draft.save({
                  type: 'agent.patch',
                  patch: { contextBudget: budget.trim(), autoNameLanes: naming },
                })
            })()
          }
        >
          Review Host policy
        </Button>
        <p className="text-text-tertiary text-sm">
          To apply saved Host policy, explicitly restart the service on {label} when running work
          can stop. Model defaults above do not need a service restart.
        </p>
      </div>
    </Card>
  )
}
