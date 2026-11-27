import { runCliBrain } from './cli-brain'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { errorText } from '@phosphor/shared/errors'
import { OPS_LIMITS, type OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import { LANE_WAIT_DEADLINE_MS, type OpRequestEnvelope } from '@phosphor/shared/ops'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import {
  helpArgv,
  optionsEnd,
  renderHelp,
  resolveOp,
  unknownOperation,
} from '@phosphor/shared/ops-cli'
import { EXIT } from './checks'
import type { CliContext, CliIo } from './cli-handlers'
import { openLocalClient } from './local-client'

type Client = ReturnType<typeof openLocalClient>

export const catalogOp = (argv: readonly string[]) => resolveOp(argv, OP_CATALOG).spec?.name

/** Ask the owner first; static help must not imply every listed handler is installed. */
async function runCatalogHelp(
  argv: readonly string[],
  io: CliIo,
  context: CliContext,
): Promise<number> {
  let client: Client | undefined
  try {
    client = openLocalClient(context)
    const result = await client.run(envelope(argv))
    if (result.status === 'ok') {
      io.stdout(`${result.text}\n`)
      return EXIT.ok
    }
    if (result.status === 'denied' && result.code !== 'unsupported') {
      io.stderr(`${result.text}\n`)
      return 1
    }
  } catch {
    // No owner reachable; static schema help remains useful during setup.
  } finally {
    client?.close()
  }
  io.stdout(`Static catalog (service unavailable):\n${renderHelp(OP_CATALOG, argv[1])}\n`)
  return EXIT.ok
}

const denied = (
  code: Extract<OpsRunResult, { status: 'denied' }>['code'],
  text: string,
): Extract<OpsRunResult, { status: 'denied' }> => ({ status: 'denied', code, text })
const expired = () => denied('confirm-expired', 'Approval timed out. No change was submitted.')
// A newly selected CLI can still be talking to the previous Host owner during an update.
const LEGACY_CLI_BACKSTOP_MS = 600_000
const envelope = (argv: readonly string[]): OpRequestEnvelope => ({
  v: 1,
  id: randomUUID(),
  argv,
  // The owner still applies the resolved op's catalog deadline.
  deadlineMs: catalogOp(argv) === 'lane.wait' ? LANE_WAIT_DEADLINE_MS : LEGACY_CLI_BACKSTOP_MS,
})

async function afterApproval(
  client: Client,
  request: OpRequestEnvelope,
  ask: Extract<OpsRunResult, { status: 'confirm' }>,
  io: CliIo,
): Promise<OpsRunResult> {
  io.stderr(
    `${ask.title}\n${ask.message}\nApprove in Phosphor: Settings → Agent → Pending approvals\n`,
  )
  const deadline = Math.min(ask.expiresAt, Date.now() + OPS_LIMITS.confirmTtlMs)
  const confirm = { confirmId: ask.confirmId, digest: ask.digest }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<OpsRunResult>((resolve) => {
    timer = setTimeout(() => resolve(expired()), Math.max(0, deadline - Date.now()))
  })
  try {
    while (Date.now() < deadline) {
      const result = await Promise.race([
        client.run(envelope(['confirm.status', ask.confirmId])),
        timeout,
      ])
      if (result.status === 'denied') return result
      if (Date.now() >= deadline) return expired()
      const state = result.status === 'ok' && (result.data as { state?: unknown } | null)?.state
      if (state === 'approved') return client.run({ ...request, id: randomUUID(), confirm })
      if (state === 'denied') return denied('confirm-denied', 'The user denied this operation.')
      if (state === 'expired') return expired()
      if (state !== 'pending')
        return denied('unavailable', 'The Phosphor service returned an unknown approval state.')
      await delay(Math.min(2000, deadline - Date.now()))
    }
    return expired()
  } finally {
    clearTimeout(timer)
  }
}

function exitFor(result: OpsRunResult): number {
  if (result.status === 'confirm') return 1
  const batch = result.data as { summary?: { failed?: number }; hosts?: unknown } | null | undefined
  if (Array.isArray(batch?.hosts) && typeof batch.summary?.failed === 'number')
    return result.status === 'ok' && batch.summary.failed === 0 ? EXIT.ok : 1
  return result.status === 'ok' ? EXIT.ok : result.code === 'confirm-expired' ? EXIT.tempfail : 1
}

/** Catalog args execute on the installed owner; this binary only routes help and command names. */
export async function runCliOps(
  argv: readonly string[],
  io: CliIo,
  context: CliContext,
): Promise<number> {
  if (argv[0] === 'brain') return runCliBrain(argv.slice(1), io, context)
  const normalized = helpArgv(argv, OP_CATALOG)
  const op = catalogOp(normalized)
  if (!op) {
    io.stderr(`phosphor: ${unknownOperation(argv, OP_CATALOG)}\n`)
    return EXIT.usage
  }
  if (op === 'help') return runCatalogHelp(normalized, io, context)
  const json = argv.slice(0, optionsEnd(argv)).includes('--json')
  let client: Client | undefined
  let result: OpsRunResult
  try {
    client = openLocalClient(context)
    const request = envelope(argv)
    result = await client.run(request)
    if (result.status === 'confirm') result = await afterApproval(client, request, result, io)
    if (result.status === 'confirm')
      result = denied('confirm-mismatch', 'Approval changed. Review and try again.')
  } catch (error) {
    result = denied('unavailable', errorText(error))
  } finally {
    client?.close()
  }
  if (json) io.stdout(`${JSON.stringify(result)}\n`)
  else if (result.status === 'ok') io.stdout(`${result.text}\n`)
  else io.stderr(`${result.text}\n`)
  return exitFor(result)
}
