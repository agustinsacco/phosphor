/**
 * The Host's interactive Brain Agent profile: only Brain Agent's own tools run. Every other tool
 * call, built-in, from another extension or from pi's MCP, is blocked before it runs. The Host
 * loads this only into a reserved Brain Agent process it starts for a person's messages, and
 * reads the command below from pi's own command list to prove this process loaded it.
 */
import { BRAIN_AGENT_GUARD_COMMAND, BRAIN_CURATOR_METHODS } from '@phosphor/shared/brain-agent'

export { BRAIN_AGENT_GUARD_COMMAND }

const ALLOWED: ReadonlySet<string> = new Set(
  BRAIN_CURATOR_METHODS.map((method) => `brain_${method}`),
)
const BLOCKED = {
  block: true,
  reason: 'Brain Agent can use only its Brain tools when someone messages it on a Host.',
} as const

interface GuardApi {
  on(event: 'tool_call', handler: (event: unknown) => typeof BLOCKED | undefined): void
  registerCommand(
    name: string,
    command: { description: string; handler(args: string): Promise<void> },
  ): void
}

export default function brainAgentGuard(pi: GuardApi): void {
  pi.on('tool_call', (event) => {
    const name =
      typeof event === 'object' && event !== null && 'toolName' in event ? event.toolName : null
    return typeof name === 'string' && ALLOWED.has(name) ? undefined : BLOCKED
  })
  pi.registerCommand(BRAIN_AGENT_GUARD_COMMAND, {
    description: 'Host proof that Brain Agent’s tool guard is loaded; does nothing',
    handler: async () => {},
  })
}
