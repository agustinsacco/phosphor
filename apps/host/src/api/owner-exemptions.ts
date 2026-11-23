import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import type { ConnectionPrincipal } from './principal'

/**
 * Parity exemptions (reconcile-v1 B9): Host limits that a remote client keeps
 * but This Mac's owner, Desktop on the attested local socket, never had in-app.
 * They are keyed only on the connection's principal, never on a client id, so
 * no grant connection (user or machine) can get one. Each service consults the
 * flag in one line:
 *
 * - terminals: no per-lane cap of 8 (`terminals/operations.ts` createTerminal)
 *   and no 64 KiB/s input throttle (`input`). The per-Host 32 stays, because
 *   the frozen `parseTerminalList` reads at most 32 rows.
 * - attachments: uploads are not charged to the lane's hourly quota
 *   (`features/attachments/upload.ts`).
 * - `bash` and `compact` have no answer deadline (`lanes/commands/queue.ts`).
 *   Their receipt settles when pi answers, when the request fails (the lane
 *   stops, pi exits) or when the owner connection that sent it closes.
 *
 * Contract tests, one per exemption, drive grant-user and grant-machine
 * connections through the same lane adapter: owner-exemptions.test.ts.
 */
export function ownerExempt(principal: ConnectionPrincipal | undefined): boolean {
  return principal?.kind === 'owner'
}

/** What an owner connection's lane commands carry. `closed` aborts when the connection closes. */
export interface OwnerExemption {
  readonly closed: AbortSignal
}

/** One connection's exemption: `sender` spreads into its lane command clients, `end` runs on close. */
export function createOwnerExemption(principal: ConnectionPrincipal | undefined) {
  const controller = ownerExempt(principal) ? new AbortController() : undefined
  const ownerExemption: OwnerExemption | undefined = controller && { closed: controller.signal }
  return {
    exempt: controller !== undefined,
    sender: ownerExemption ? { ownerExemption } : {},
    end: () => controller?.abort(),
  }
}

/** Ops pi may take longer than the answer deadline to answer: `!cmd` and compaction. */
const UNBOUNDED_OWNER_ANSWERS: ReadonlySet<string> = new Set(['bash', 'compact'])

/** How long a command's answer is awaited: the Host deadline, or until the owner's connection closes. */
export function answerWait(
  exemption: OwnerExemption | undefined,
  opType: string,
): number | AbortSignal {
  return exemption && UNBOUNDED_OWNER_ANSWERS.has(opType)
    ? exemption.closed
    : HOST_LIMITS.commandAnswerMs
}
