import { OPS_LIMITS } from '@phosphor/shared/host-protocol-ops'
import {
  brainVersionMode,
  parseHostBrainRequest,
  type HostBrainRequest,
  type HostBrainVersion,
} from '@phosphor/shared/host-brain-request'
import {
  BRAIN_COMMANDS,
  brainCommandName,
  brainCommandWords,
  type BrainCommand,
  type BrainCommandName,
  type BrainOperand,
} from './cli-brain-commands'

export type BrainCliParse =
  { ok: true; action: HostBrainRequest; json: boolean } | { ok: false; problem: string }

const STAMP = 'GENERATION:REVISION'
const STAMP_SOURCE = `--expected ${STAMP} from phosphor brain status --json`
/** Brain has no remote or fleet route from this binary; the connection is the target. */
export const BRAIN_THIS_HOST_ONLY =
  'Brain commands act on this Host only, through its local Phosphor service socket. For another Host, use its Brain page or run phosphor on that Host. No Host was contacted.'
const APPROVAL = `Every command, reads included, runs once you approve it on this Host’s authenticated Brain surface; it waits up to ${OPS_LIMITS.confirmTtlMs / 60_000} minutes. Without --json a command prints only whether it completed.`

const guarded = (command: BrainCommand) => brainVersionMode(command.method) !== undefined
const fail = (problem: string): BrainCliParse => ({ ok: false, problem })

function operandUsage(operand: BrainOperand): string[] {
  if (operand.kind === 'revision' || operand.kind === 'fixed') return []
  const label = operand.kind === 'on-off' ? operand.name : `<${operand.name}>`
  return [
    'optional' in operand || ('fallback' in operand && operand.fallback !== undefined)
      ? `[${label}]`
      : label,
  ]
}

function usage(name: BrainCommandName): string {
  const command: BrainCommand = BRAIN_COMMANDS[name]
  return [
    'phosphor brain',
    name,
    ...(command.operands ? command.operands.flatMap(operandUsage) : ['--args JSON_ARRAY']),
    ...(guarded(command) ? [`--expected ${STAMP}`] : []),
    '[--json]',
  ].join(' ')
}

/** The overview with no topic; one command's usage for a topic; undefined for an unknown one. */
export function brainHelp(topic?: string): string | undefined {
  if (topic === undefined) {
    const names = Object.keys(BRAIN_COMMANDS) as BrainCommandName[]
    return [
      `Usage: phosphor brain <command> [operands] [--expected ${STAMP}] [--json]`,
      BRAIN_THIS_HOST_ONLY.replace(' No Host was contacted.', ''),
      APPROVAL,
      'Commands:',
      ...names.map((name) => `  ${usage(name)}\n      ${BRAIN_COMMANDS[name].summary}`),
      `Writes that need ${STAMP} take it from phosphor brain status --json; a stale stamp is refused, never retried.`,
      '--args JSON_ARRAY replaces the operands with the exact wire arguments.',
      'In a lane, phosphor brain search and phosphor brain flag use that lane’s recall: see phosphor help brain.search.',
      'Use phosphor brain <command> --help for one command.',
    ].join('\n')
  }
  const name = brainCommandName(topic.split(/[\s]+/))
  if (!name) return undefined
  const command: BrainCommand = BRAIN_COMMANDS[name]
  return [
    `Usage: ${usage(name)}`,
    command.summary,
    ...(guarded(command) ? [`Takes ${STAMP_SOURCE}.`] : []),
    APPROVAL,
  ].join('\n')
}

function operandValue(operand: BrainOperand, raw: string | undefined): unknown {
  if (operand.kind === 'fixed') return operand.value
  if (operand.kind === 'revision' || raw === undefined) return undefined
  if (operand.kind === 'text') return raw
  if (operand.kind === 'on-off') return raw === 'on' ? true : raw === 'off' ? false : undefined
  if (operand.kind === 'int') return /^\d{1,15}$/.test(raw) ? Number(raw) : undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/** Plain operands to wire arguments; a revision operand is the stamp's revision. */
function operandArgs(
  name: BrainCommandName,
  operands: readonly BrainOperand[],
  values: readonly string[],
  stamp: HostBrainVersion | undefined,
): unknown[] | string {
  const typed = operands.filter((o) => o.kind !== 'revision' && o.kind !== 'fixed')
  if (values.length > typed.length) return `Too many operands. Usage: ${usage(name)}`
  const args: unknown[] = []
  let next = 0
  for (const operand of operands) {
    if (operand.kind === 'revision') {
      args.push(stamp?.revision)
      continue
    }
    const raw = operand.kind === 'fixed' ? undefined : values[next++]
    if (raw === undefined && 'optional' in operand) continue
    const value =
      raw === undefined && 'fallback' in operand ? operand.fallback : operandValue(operand, raw)
    if (value === undefined)
      return raw === undefined
        ? `Missing operand. Usage: ${usage(name)}`
        : `An operand is not valid. Usage: ${usage(name)}`
    args.push(value)
  }
  return args
}

interface Flags {
  json: boolean
  args?: string
  expected?: string
  operands: string[]
}

function readFlags(rest: readonly string[]): Flags | string {
  const flags: Flags = { json: false, operands: [] }
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!
    if (word === '--') {
      flags.operands.push(...rest.slice(i + 1))
      break
    }
    if (!word.startsWith('--')) {
      flags.operands.push(word)
      continue
    }
    if (word === '--host') return BRAIN_THIS_HOST_ONLY
    if (word === '--json') {
      if (flags.json) return 'Duplicate --json.'
      flags.json = true
      continue
    }
    const key = word === '--args' ? 'args' : word === '--expected' ? 'expected' : undefined
    if (!key) return 'Unknown option. Use phosphor brain --help.'
    const value = rest[++i]
    if (value === undefined) return `${word} needs a value.`
    if (flags[key] !== undefined) return `Duplicate ${word}.`
    flags[key] = value
  }
  return flags
}

function parseStamp(value: string | undefined): HostBrainVersion | undefined | null {
  if (value === undefined) return undefined
  const match = /^([0-9a-f-]{36}):(\d{1,15})$/i.exec(value)
  return match ? { generation: match[1]!, revision: Number(match[2]) } : null
}

/** Checks everything it can before connecting, and never repeats an operand in a problem. */
export function parseBrainCli(argv: readonly string[]): BrainCliParse {
  const name = brainCommandName(argv)
  if (!name) return fail('Unknown Brain command. Use phosphor brain --help.')
  const command: BrainCommand = BRAIN_COMMANDS[name]
  const flags = readFlags(argv.slice(brainCommandWords(argv)))
  if (typeof flags === 'string') return fail(flags)
  const stamp = parseStamp(flags.expected)
  if (stamp === null) return fail(`--expected takes ${STAMP} from phosphor brain status --json.`)
  if (guarded(command) && !stamp)
    return fail(`phosphor brain ${name} changes Brain, so it needs ${STAMP_SOURCE}.`)
  if (!guarded(command) && stamp) return fail(`phosphor brain ${name} does not take --expected.`)
  let args: unknown
  if (flags.args !== undefined) {
    if (flags.operands.length) return fail('Use either operands or --args, not both.')
    try {
      args = JSON.parse(flags.args)
    } catch {
      return fail('--args takes a JSON array.')
    }
  } else if (!command.operands) {
    return fail(`phosphor brain ${name} takes --args JSON_ARRAY. Usage: ${usage(name)}`)
  } else {
    args = operandArgs(name, command.operands, flags.operands, stamp)
    if (typeof args === 'string') return fail(args)
  }
  const action = parseHostBrainRequest({
    method: command.method,
    args,
    ...(stamp ? { expected: stamp } : {}),
  })
  return action
    ? { ok: true, action, json: flags.json }
    : fail(`The arguments are not valid for phosphor brain ${name}. Usage: ${usage(name)}`)
}
