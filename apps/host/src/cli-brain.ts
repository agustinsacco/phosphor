import { setTimeout as delay } from 'node:timers/promises'
import { BRAIN_APPROVAL, BRAIN_METHODS, BRAIN_SURFACE } from '@phosphor/shared/host-brain'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { CliContext, CliIo } from './cli-handlers'
import { LocalBrainUnsupported, openLocalClient } from './local-client'
import { BRAIN_CLI_USAGE, parseBrainCli } from './cli-brain-args'

export async function runCliBrain(
  argv: readonly string[],
  io: CliIo,
  context: CliContext,
): Promise<number> {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help') {
    io.stdout(BRAIN_CLI_USAGE)
    return 0
  }
  const parsed = parseBrainCli(argv)
  if (!parsed) {
    io.stderr(
      `Choose one supported command on this Host, using --host local. Named remote and fleet targets cannot use the local approval path.\n${BRAIN_CLI_USAGE}`,
    )
    return 1
  }
  const { action, json } = parsed
  let client: ReturnType<typeof openLocalClient> | undefined
  try {
    client = openLocalClient(context)
    const request = { op: BRAIN_SURFACE, args: action }
    const write = BRAIN_METHODS[action.method][1]
    let result: OpsRunResult = await client.runBrain(request, write)
    if (result.status === 'confirm') {
      const { confirmId, digest, expiresAt } = result
      io.stderr(
        `${result.title}\nApprove on this Host’s authenticated Brain surface: ${confirmId.slice(0, 8)}.\n`,
      )
      while (Date.now() < expiresAt) {
        const status = await client.runBrain(
          { op: BRAIN_APPROVAL, args: { action: 'status', id: confirmId } },
          false,
        )
        const state =
          status.status === 'ok' ? (status.data as { state?: unknown } | null)?.state : undefined
        if (state === 'approved' && Date.now() < expiresAt) {
          result = await client.runBrain({ ...request, confirm: { confirmId, digest } }, write)
          break
        }
        if (state !== 'pending') break
        await delay(Math.min(2000, Math.max(0, expiresAt - Date.now())))
      }
    }
    if (result.status === 'ok') {
      if (result.data && typeof result.data === 'object' && 'brainRefusal' in result.data) {
        io.stderr(`${result.text}\n`)
        return 1
      }
      io.stdout(
        json
          ? `${JSON.stringify(result.data)}\n`
          : 'Brain operation completed. Use --json for the authorized result.\n',
      )
      return 0
    }
    io.stderr(
      `${result.status === 'denied' ? result.text : 'Brain approval was denied, expired, or the connection changed.'}\n`,
    )
  } catch (error) {
    io.stderr(
      error instanceof LocalBrainUnsupported
        ? `${error.message}\n`
        : 'The Host did not confirm the operation. Check its local service socket or authenticated Brain surface before trying again. No other Host was contacted.\n',
    )
  } finally {
    client?.close()
  }
  return 1
}

export { BRAIN_CLI_USAGE } from './cli-brain-args'
