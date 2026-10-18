import { isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { errorText } from '@phosphor/shared/errors'
import { HOST_RELEASE_VERSION_PATTERN } from '@phosphor/shared/host-release'
import type { AcceptLane } from './commands/accept'
import { isServiceAction, type ServiceAction } from './commands/service'
import { isTailscaleAction, type TailscaleAction } from './commands/tailscale'

export const CLI_PARSE_CONFIG = {
  allowPositionals: true,
  strict: true,
  options: {
    config: { type: 'string' },
    version: { type: 'string' },
    check: { type: 'boolean' },
    rollback: { type: 'boolean' },
    purge: { type: 'boolean' },
    yes: { type: 'boolean' },
    supervisor: { type: 'string' },
    json: { type: 'boolean' },
    local: { type: 'boolean' },
    follow: { type: 'boolean' },
    repository: { type: 'string', multiple: true },
    pi: { type: 'string' },
    node: { type: 'string' },
    replace: { type: 'boolean' },
    lane: { type: 'string' },
    'keep-transcripts': { type: 'boolean' },
    provider: { type: 'string' },
    'claude-model': { type: 'string' },
    model: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
} as const

/** The options each command takes; `providers login` takes only --config. */
const COMMAND_OPTIONS = {
  'internal-install-path': [],
  setup: ['config', 'json', 'repository', 'pi', 'node', 'replace'],
  doctor: ['config', 'json'],
  run: ['config', 'supervisor'],
  service: ['config', 'follow'],
  tailscale: ['config'],
  login: ['config'],
  status: ['config', 'json'],
  logout: ['config', 'local'],
  providers: ['config', 'json'],
  accept: [
    'config',
    'json',
    'repository',
    'lane',
    'keep-transcripts',
    'provider',
    'model',
    'claude-model',
  ],
  version: ['json'],
  update: ['version', 'check', 'rollback', 'json'],
  uninstall: ['purge', 'yes', 'json'],
} as const satisfies Record<string, readonly (keyof typeof CLI_PARSE_CONFIG.options)[]>

export type CommandName = keyof typeof COMMAND_OPTIONS

function parse(argv: readonly string[]) {
  return parseArgs({ ...CLI_PARSE_CONFIG, args: [...argv] })
}

export type CliOptions = ReturnType<typeof parse>['values']

/** One `{ name }` member per command, so a check on `name` narrows to it. */
type Named<N extends string> = N extends string ? { name: N } : never

/** A command and the positionals after its name, before its options are checked. */
type CommandOperands =
  | { name: 'service'; action: ServiceAction }
  | { name: 'tailscale'; action: TailscaleAction }
  | { name: 'providers login'; provider: string }
  | Named<Exclude<CommandName, 'service' | 'tailscale'>>

type OptionCommand = 'setup' | 'accept' | 'run'

/** A command whose arguments all passed: the dispatch receives nothing it must check again. */
export type ValidatedCommand = { options: CliOptions } & (
  | Exclude<CommandOperands, { name: OptionCommand }>
  | { name: 'setup'; repositories: string[] }
  | { name: 'accept'; repository: string; lane: AcceptLane | 'all' }
  | { name: 'run'; supervisor: 'launchd' | undefined }
)

export type CliRequest =
  | { kind: 'help' }
  | { kind: 'usage'; problem: string }
  | { kind: 'command'; command: ValidatedCommand }

/**
 * Parse and check argv in the order the CLI reports problems: a parse error,
 * then help (which wins over every other refusal), then the command and its
 * positionals, the options it takes, the shared option values, and last what
 * one command alone checks.
 */
export function readCliRequest(argv: readonly string[], terminal: boolean | undefined): CliRequest {
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(
      argv.length === 1 && ['--version', '-v'].includes(argv[0] ?? '') ? ['version'] : argv,
    )
  } catch (error) {
    return { kind: 'usage', problem: errorText(error) }
  }
  const { values: options, positionals } = parsed
  if (options.help || positionals[0] === 'help') return { kind: 'help' }
  const operands = commandOperands(positionals, options)
  if (typeof operands === 'string') return { kind: 'usage', problem: operands }
  const problem = optionProblem(operands.name, options, terminal) ?? valueProblem(options)
  if (problem !== undefined) return { kind: 'usage', problem }
  const command = validatedCommand(operands, options)
  return typeof command === 'string'
    ? { kind: 'usage', problem: command }
    : { kind: 'command', command }
}

function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(COMMAND_OPTIONS, value)
}

const unexpected = (argument: string) => `unexpected argument "${argument}"`

function commandOperands(
  positionals: readonly string[],
  options: CliOptions,
): CommandOperands | string {
  const [command, first, ...rest] = positionals
  if (command === undefined) return 'no command given'
  if (!isCommandName(command)) return `unknown command "${command}"`
  if (command === 'providers' && first === 'login') {
    const [provider, extra] = rest
    if (provider === undefined)
      return 'providers login needs a provider: an id phosphor providers lists, or claude'
    return extra === undefined ? { name: 'providers login', provider } : unexpected(extra)
  }
  if (command === 'service') {
    if (!isServiceAction(first)) return 'service needs install, status, restart, logs or uninstall'
    if (options.follow && first !== 'logs') return '--follow is only for service logs'
    return rest[0] === undefined ? { name: command, action: first } : unexpected(rest[0])
  }
  if (command === 'tailscale') {
    if (!isTailscaleAction(first)) return 'tailscale needs status, enable or disable'
    return rest[0] === undefined ? { name: command, action: first } : unexpected(rest[0])
  }
  return first === undefined ? { name: command } : unexpected(first)
}

/** An option the command does not take, then a login with no terminal to hand it. */
function optionProblem(
  name: CommandOperands['name'],
  options: CliOptions,
  terminal: boolean | undefined,
): string | undefined {
  const allowed: readonly string[] = name === 'providers login' ? ['config'] : COMMAND_OPTIONS[name]
  const refused = Object.keys(options).find((option) => !allowed.includes(option))
  if (refused) return `${name} does not take --${refused}`
  if (name === 'providers login' && !terminal)
    return 'providers login needs a terminal: over SSH, run ssh -t HOST phosphor ...'
  return undefined
}

/** Values of options more than one command could take. */
function valueProblem(options: CliOptions): string | undefined {
  if (options.supervisor !== undefined && options.supervisor !== 'launchd')
    return '--supervisor is launchd'
  if (options.config === '') return '--config needs a file'
  return undefined
}

/** Each option checked here belongs to one command alone, so no order between them shows. */
function validatedCommand(
  operands: CommandOperands,
  options: CliOptions,
): ValidatedCommand | string {
  switch (operands.name) {
    case 'accept':
      return acceptCommand(options)
    case 'setup': {
      const repositories = options.repository ?? []
      if (repositories.includes('') || options.pi === '' || options.node === '')
        return '--repository, --pi and --node need a path'
      return { name: 'setup', repositories, options }
    }
    case 'run':
      return {
        name: 'run',
        supervisor: options.supervisor === 'launchd' ? 'launchd' : undefined,
        options,
      }
    case 'update':
      return updateProblem(options) ?? { ...operands, options }
    case 'uninstall':
      if (Boolean(options.purge) !== Boolean(options.yes))
        return '--purge and --yes are both required'
      return { ...operands, options }
    default:
      return { ...operands, options }
  }
}

const isAcceptChoice = (lane: string): lane is AcceptLane | 'all' =>
  lane === 'native' || lane === 'claude' || lane === 'all'

function acceptCommand(options: CliOptions): ValidatedCommand | string {
  const lane = options.lane ?? 'all'
  if (!isAcceptChoice(lane)) return '--lane is native, claude or all'
  const repositories = options.repository ?? []
  if (repositories.length > 1) return '--repository may only repeat for setup'
  const [repository] = repositories
  if (!repository) return 'accept needs --repository DIR'
  if (!isAbsolute(repository)) return '--repository needs an absolute path'
  return { name: 'accept', repository, lane, options }
}

function updateProblem({ version, check, rollback }: CliOptions): string | undefined {
  if (version !== undefined && !HOST_RELEASE_VERSION_PATTERN.test(version))
    return 'invalid update options'
  if (rollback && (version !== undefined || check)) return 'invalid update options'
  return undefined
}

/**
 * The command and every --supervisor value, read from raw argv without
 * parseArgs, so a usage error can still be told apart for a supervised run.
 */
export function scanArgv(argv: readonly string[]): {
  command: string | undefined
  supervisors: (string | undefined)[]
} {
  let command: string | undefined
  const supervisors: (string | undefined)[] = []
  let positional = false
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === undefined) continue
    if (!positional && token === '--') {
      positional = true
      continue
    }
    if (!positional && token.startsWith('-') && token !== '-') {
      const equal = token.indexOf('=')
      const name = token.startsWith('--')
        ? token.slice(2, equal < 0 ? undefined : equal)
        : undefined
      const option = Object.entries(CLI_PARSE_CONFIG.options).find(
        ([long, option]) => name === long || ('short' in option && token === `-${option.short}`),
      )
      if (option?.[1].type === 'string') {
        const value = equal < 0 ? argv[++index] : token.slice(equal + 1)
        if (option[0] === 'supervisor') supervisors.push(value)
      }
      continue
    }
    command ??= token
  }
  return { command, supervisors }
}

/** `run` whose every --supervisor is launchd: a usage error is then a permanent service exit. */
export function supervisedRun(argv: readonly string[]): boolean {
  const { command, supervisors } = scanArgv(argv)
  return (
    command === 'run' && supervisors.length > 0 && supervisors.every((value) => value === 'launchd')
  )
}
