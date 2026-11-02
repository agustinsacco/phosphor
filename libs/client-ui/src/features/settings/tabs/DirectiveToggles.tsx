import { useMemo } from 'react'
import { TooltipSummary } from '@/components/Tooltip'
import { Row, Toggle } from '@/components/form'
import type { MachineContext } from '@shared/machine-prompt'
import type { AgentDirectivePrefs } from '@shared/models'
import { directivesPreview } from './directivesPreview'

const TOGGLES: readonly { key: keyof AgentDirectivePrefs; title: string; description: string }[] = [
  {
    key: 'worktreeGuard',
    title: 'Worktree guard',
    description:
      'Tells a worktree lane that the main checkout is a different branch. Stops a class of confident wrong-branch answers.',
  },
  {
    key: 'machineAwareness',
    title: 'Machine awareness',
    description:
      "Tells signed-in local lanes where Phosphor's window is. Host lanes identify their machine and warn against disrupting their own service. Fixed when a lane starts.",
  },
  {
    key: 'laneCharter',
    title: 'Lane charter',
    description:
      'States that this is a lane, that it owns its branch, that it ends in a pull request, that the change stays reviewable, and that checks are run rather than claimed.',
  },
  {
    key: 'subagentPolicy',
    title: 'Sub-agent policy',
    description:
      'Prefers direct answers for small work. For broader delegation, distinguishes native Claude Agent parameters from pi subagent parameters and asks the agent to wait for findings.',
  },
]

/**
 * The generated blocks Phosphor appends to a lane's system prompt, each on or
 * off, and the composed result. They carry per-lane facts and stay Phosphor's
 * to word, so they are switches rather than text in the instructions file.
 */
export function DirectiveToggles({
  value,
  machine,
  disabled,
  onChange,
}: {
  value: AgentDirectivePrefs
  machine: MachineContext
  disabled?: boolean
  onChange: (patch: Partial<AgentDirectivePrefs>) => void
}): React.JSX.Element {
  const preview = useMemo(() => directivesPreview(value, machine), [value, machine])
  return (
    <>
      {TOGGLES.map(({ key, title, description }) => (
        <Row key={key} title={title} description={description}>
          <Toggle on={value[key]} disabled={disabled} onChange={(on) => onChange({ [key]: on })} />
        </Row>
      ))}
      <details className="border-border bg-bg-secondary rounded-lg border">
        <TooltipSummary className="text-text-secondary cursor-pointer px-3 py-2 font-mono text-xs uppercase">
          What gets sent ({preview.length} chars)
        </TooltipSummary>
        <pre className="text-text-secondary overflow-x-auto px-3 pb-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {preview || 'Nothing: every block is off.'}
        </pre>
      </details>
    </>
  )
}
