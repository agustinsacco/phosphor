import { useMemo, useState } from 'react'
import { Button } from '@/components/form'
import { DirectiveToggles } from '@/features/settings/tabs/DirectiveToggles'
import { EditInstructions } from '@/features/settings/instructions/EditInstructions'
import { hostInstructions } from '@/features/settings/instructions/instructionsSource'
import type { MachineContext } from '@shared/machine-prompt'
import { Card } from './MachineUi'
import type { MachineAgentController } from './useMachineAgentSettings'

/**
 * A Host's own instructions file and its directive switches. Both are the
 * Host's, not the account's: each machine keeps its own and nothing syncs.
 *
 * The instructions reach running lanes at their next message. The switches
 * autosave as Host configuration read when a lane starts, so they need no
 * service restart, unlike the policy below them.
 */
export function MachineDirectives({
  controller,
  hostId,
  label,
}: {
  controller: MachineAgentController
  hostId: string
  label: string
}): React.JSX.Element {
  const { draft, busy } = controller
  const [editing, setEditing] = useState(false)
  const source = useMemo(() => hostInstructions(hostId, label), [hostId, label])
  // OS and repositories are filled in from the Host when a lane starts.
  const machine = useMemo<MachineContext>(
    () => ({ kind: 'host', label, os: 'host-os', repositories: [] }),
    [label],
  )
  const value = draft.fields.directives

  return (
    <Card title="Instructions and directives">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-text-secondary flex-1 text-base">
            Global instructions are pi&apos;s AGENTS.md on {label}. Every lane there loads it, and
            running lanes use a save from their next message.
          </p>
          <Button size="sm" onClick={() => setEditing(true)}>
            Edit instructions
          </Button>
        </div>
        <DirectiveToggles
          value={value}
          machine={machine}
          disabled={busy}
          onChange={(patch) => draft.set('directives', { ...value, ...patch })}
        />
      </div>
      {editing && <EditInstructions source={source} onClose={() => setEditing(false)} />}
    </Card>
  )
}
