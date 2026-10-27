import { Button } from '@/components/form'
import type { MachineAgentBehavior as Behavior } from '@shared/machine-agent-behavior'
import { promptChoice } from '@/stores/prompt'
import { Card } from './MachineUi'
import { BehaviorDelivery, BehaviorPolicy, BehaviorToggle } from './HostBehaviorFields'
import type { MachineAgentController } from './useMachineAgentSettings'

export function MachineAgentBehavior({
  controller,
  label,
}: {
  controller: MachineAgentController
  label: string
}): React.JSX.Element {
  const { draft, busy } = controller
  const value = draft.fields.behavior
  const update = <K extends keyof Behavior>(key: K, next: Behavior[K]) =>
    draft.set('behavior', { ...value, [key]: next })
  return (
    <Card title="Agent behavior">
      <p className="text-text-secondary mb-3 text-base">
        Only explicit overrides are saved. Empty settings use pi’s defaults, or inherit machine
        settings in folder scope. Changes apply to new lanes on {label}.
      </p>
      <div className="space-y-4">
        <BehaviorToggle
          title="Hide thinking blocks"
          value={value.hideThinkingBlock}
          busy={busy}
          change={(v) => update('hideThinkingBlock', v)}
        />
        {(['steeringMode', 'followUpMode'] as const).map((key) => (
          <BehaviorDelivery
            key={key}
            type={key}
            value={value[key]}
            busy={busy}
            change={(v) => update(key, v)}
          />
        ))}
        {(['compaction', 'retry'] as const).map((key) => (
          <BehaviorPolicy
            key={key}
            type={key}
            value={value[key]}
            busy={busy}
            change={(v) => update(key, v)}
          />
        ))}
        <Button
          disabled={busy}
          onClick={() =>
            void (async () => {
              if (
                (await promptChoice({
                  title: `Save agent behavior on ${label}?`,
                  message:
                    'Only this configuration scope changes. Running lanes are not restarted. Claude and native providers use the same compaction and retry settings.',
                  choices: [{ value: 'save', label: 'Save behavior', primary: true }],
                })) === 'save'
              )
                await draft.save({ type: 'agent.patch', patch: value })
            })()
          }
        >
          Review agent behavior
        </Button>
      </div>
    </Card>
  )
}
