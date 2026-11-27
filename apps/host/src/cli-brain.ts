import { BRAIN_APPROVAL, BRAIN_METHODS, BRAIN_SURFACE } from '@phosphor/shared/host-brain'
import {
  OPS_LIMITS,
  type OpsRunRequest,
  type OpsRunResult,
} from '@phosphor/shared/host-protocol-ops'
import { EXIT } from './checks'
import type { CliContext, CliIo } from './cli-handlers'
import { LocalBrainUnsupported, openLocalClient } from './local-client'
import { brainHelp, parseBrainCli } from './cli-brain-args'

type Client = ReturnType<typeof openLocalClient>
type Ask = Extract<OpsRunResult, { status: 'confirm' }>
type Unanswered = 'denied' | 'expired' | 'lost'

const UNANSWERED: Record<Unanswered, readonly [string, number]> = {
  denied: ['The approver denied this Brain operation.', 1],
  expired: ['Approval timed out. No Brain operation ran.', EXIT.tempfail],
  lost: ['Brain approval was withdrawn or the connection changed. No Brain operation ran.', 1],
}
const UNCONFIRMED =
  'The Host did not confirm the operation. Check its local service socket or authenticated Brain surface before trying again. No other Host was contacted.'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Poll the issuing socket's approval; the wait never outlives the confirmation lifetime. */
async function afterApproval(
  client: Client,
  request: OpsRunRequest,
  write: boolean,
  ask: Ask,
  io: CliIo,
): Promise<OpsRunResult | Unanswered> {
  io.stderr(
    `${ask.title}\nApprove on this Host’s authenticated Brain surface: ${ask.confirmId.slice(0, 8)}.\n`,
  )
  const deadline = Math.min(ask.expiresAt, Date.now() + OPS_LIMITS.confirmTtlMs)
  const status = { op: BRAIN_APPROVAL, args: { action: 'status', id: ask.confirmId } }
  while (Date.now() < deadline) {
    const reply = await pollUntil(client, status, deadline)
    if (!reply || Date.now() >= deadline) return 'expired'
    const state = reply.status === 'ok' && (reply.data as { state?: unknown } | null)?.state
    if (state === 'approved') {
      const confirm = { confirmId: ask.confirmId, digest: ask.digest }
      return client.runBrain({ ...request, confirm }, write)
    }
    if (state === 'denied' || state === 'expired') return state
    if (state !== 'pending') return 'lost'
    await sleep(Math.min(2000, deadline - Date.now()))
  }
  return 'expired'
}

async function pollUntil(client: Client, status: OpsRunRequest, deadline: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      client.runBrain(status, false),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function helpTopic(argv: readonly string[]): string | null | undefined {
  const words = argv.slice(0, argv.includes('--') ? argv.indexOf('--') : argv.length)
  if (argv.length === 0 || ['help', '--help', '-h'].includes(argv[0]!))
    return argv.slice(1).join(' ') || undefined
  if (!words.some((word) => word === '--help' || word === '-h')) return null
  return words.filter((word) => !word.startsWith('-')).join(' ')
}

/** Answers help offline; any other command acts on this Host after one approval, or not at all. */
export async function runCliBrain(
  argv: readonly string[],
  io: CliIo,
  context: CliContext,
): Promise<number> {
  const topic = helpTopic(argv)
  if (topic !== null) {
    const help = brainHelp(topic)
    if (help) io.stdout(`${help}\n`)
    else io.stderr('phosphor brain: Unknown Brain command. Use phosphor brain --help.\n')
    return help ? EXIT.ok : EXIT.usage
  }
  const parsed = parseBrainCli(argv)
  if (!parsed.ok) {
    io.stderr(`phosphor brain: ${parsed.problem}\n`)
    return EXIT.usage
  }
  const { action, json } = parsed
  let client: Client | undefined
  try {
    client = openLocalClient(context)
    const request: OpsRunRequest = { op: BRAIN_SURFACE, args: action }
    const write = BRAIN_METHODS[action.method][1]
    let result: OpsRunResult | Unanswered = await client.runBrain(request, write)
    if (typeof result !== 'string' && result.status === 'confirm')
      result = await afterApproval(client, request, write, result, io)
    if (typeof result === 'string') {
      const [text, code] = UNANSWERED[result]
      io.stderr(`${text}\n`)
      return code
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
      return EXIT.ok
    }
    io.stderr(`${result.status === 'denied' ? result.text : UNANSWERED.lost[0]}\n`)
  } catch (error) {
    io.stderr(`${error instanceof LocalBrainUnsupported ? error.message : UNCONFIRMED}\n`)
  } finally {
    client?.close()
  }
  return 1
}
