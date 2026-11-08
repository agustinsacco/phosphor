import type { ReleaseState } from './release-lease'
import type { Policy } from './release-github'
import { releaseBashRefusal } from './release-guard'
import { applyReleaseContext, releasePrompt } from './release-prompt'
import type { ReleaseStatus } from './release-status'

/** The parts of a release lane its pi hooks read and set. */
export interface HookLane {
  pi: { on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void }
  enabled: boolean
  role: ReleaseStatus['role']
  quiet: boolean
  userInput: boolean
  policy: Policy
  state?: ReleaseState
}

/**
 * Decide, as each run starts, whether its end deserves an alert: a person's
 * prompt does; in the lane holding the lease, a pass, an answer or a
 * sub-agent's report does not, unless the manager flags it or someone speaks to the lane meanwhile.
 */
export function watchRuns(lane: HookLane, publish: () => void): void {
  lane.pi.on('input', (event) => {
    const input = event as { source?: string; streamingBehavior?: string }
    if (input.source === 'extension') return
    // Mid-run, the message joins the current run; otherwise it starts the next one.
    if (!input.streamingBehavior) lane.userInput = true
    if (!lane.quiet) return
    lane.quiet = false
    publish()
  })
  lane.pi.on('before_agent_start', () => {
    // Only the lease holder works unattended; a standby's runs are a person's.
    const quiet = lane.role === 'active' && !lane.userInput
    lane.userInput = false
    if (quiet === lane.quiet) return
    lane.quiet = quiet
    publish()
  })
}

/** In release mode: refuse risky bash, and give the model its manual or the standby rule. */
export function guardAndPrompt(lane: HookLane): void {
  lane.pi.on('tool_call', (event) => {
    const call = event as { toolName?: string; input?: { command?: unknown } }
    if (!lane.enabled || call.toolName !== 'bash' || typeof call.input?.command !== 'string') return
    const reason = releaseBashRefusal(call.input.command, lane.policy.base)
    return reason ? { block: true, reason } : undefined
  })
  lane.pi.on('context_with_system', (event) => {
    const messages = (event as { messages: unknown[] }).messages
    const text = lane.enabled
      ? releasePrompt(lane.role === 'active' ? 'active' : 'standby', lane.state?.lease?.epoch)
      : undefined
    applyReleaseContext(messages, text)
    return { messages }
  })
}
