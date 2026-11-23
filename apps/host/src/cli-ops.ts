import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { errorText } from '@phosphor/shared/errors'
import { OPS_LIMITS, type OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { OpRequestEnvelope } from '@phosphor/shared/ops'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import { OP_ALIASES, renderHelp } from '@phosphor/shared/ops-cli'
import { EXIT } from './checks'
import type { CliContext, CliIo } from './cli-handlers'
import { openLocalClient } from './local-client'

export type CommandTable = (
  argv: readonly string[],
  io: CliIo,
  context: CliContext,
) => Promise<number>

type Client = ReturnType<typeof openLocalClient>
const topics = new Set([
  ...Object.keys(OP_ALIASES),
  ...OP_CATALOG.flatMap(({ name }) => [name, name.split('.')[0]!]),
])
export const catalogTopic = (word?: string) =>
  word && topics.has(word) ? `${renderHelp(OP_CATALOG, word)}\n` : null

const denied = (
  code: Extract<OpsRunResult, { status: 'denied' }>['code'],
  text: string,
): OpsRunResult => ({ status: 'denied', code, text })
const expired = () => denied('confirm-expired', 'Approval timed out. No change was submitted.')
const envelope = (argv: readonly string[]): OpRequestEnvelope => ({
  v: 1,
  id: randomUUID(),
  argv,
  deadlineMs: 30_000,
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

/** The fixed command table still owns unknown commands and its existing help forms. */
export async function runCliOps(
  argv: readonly string[],
  io: CliIo,
  context: CliContext,
  commandTable: CommandTable,
): Promise<number> {
  if (!topics.has(argv[0] ?? '') || (argv.length === 2 && ['-h', '--help'].includes(argv[1]!)))
    return commandTable(argv, io, context)
  const end = argv.indexOf('--')
  const json = argv.slice(0, end < 0 ? argv.length : end).includes('--json')
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
  return result.status === 'ok' ? EXIT.ok : result.code === 'confirm-expired' ? EXIT.tempfail : 1
}
