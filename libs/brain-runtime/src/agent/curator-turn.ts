import type { CuratorContext } from './curator-context'

export const BRAIN_TURN_REFUSAL =
  'This Brain Agent turn has no authority to use Brain now. Nothing was changed.'

/** The turn a curator call belongs to, captured when the call arrives. */
export interface CuratorTurn {
  /** The Defrag run a change is journaled under, or null. */
  runId(): string | null
  /** Still that turn's authority: checked again immediately before every write. */
  admit(): boolean
}

/**
 * The turn asking, or null when it has no authority. Desktop's lane has no gate: its owner's
 * turns and Defrag's write as they always have, journaled under the run answering at the write.
 * The Host's reserved lane binds each call to the exact turn running when it arrives: a
 * controller's while they keep their authority, a Defrag run's while that same run answers.
 */
export function curatorTurn(
  context: Pick<CuratorContext, 'options' | 'defrag'>,
): CuratorTurn | null {
  const agent = context.options.agent
  if (!agent?.turnGate)
    return { runId: () => context.defrag.turnRun()?.runId ?? null, admit: () => true }
  const gate = agent.turnGate()
  if (!gate?.admit()) return null
  if (gate.kind === 'controller') return { runId: () => null, admit: () => gate.admit() }
  const run = context.defrag.turnRun()
  if (!run) return null
  return { runId: () => run.runId, admit: () => gate.admit() && context.defrag.turnRun() === run }
}
