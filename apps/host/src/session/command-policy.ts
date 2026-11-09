import type { RpcCommand, RpcCommandType } from '@phosphor/shared/rpc'

/** What the Host does with a command: pass it (null), refuse it (why), or decide from it. */
type CommandRule<K extends RpcCommandType> =
  null | string | ((command: Extract<RpcCommand, { type: K }>) => string | null)

const MOVES_FILE = 'moves pi to another session file: start or resume one with a request instead'

/** pi tries a prompt as an extension command only when it starts with "/". */
export function mayRunExtensionCommand(command: RpcCommand): boolean {
  return (
    command.type === 'prompt' &&
    (typeof command.message !== 'string' || command.message.startsWith('/'))
  )
}

/**
 * Every pi command, so one added to the protocol does not compile until it
 * is placed here. A session file reaches pi only through the request parser,
 * so the Host always knows which file each pi writes: that is what refuses a
 * second start of a file and the deletion of a running one. A command that
 * moves pi to another file would leave the Host believing the old one.
 */
const COMMANDS: { [K in RpcCommandType]: CommandRule<K> } = {
  prompt: null,
  steer: null,
  follow_up: null,
  abort: null,
  clear_queue: null,
  get_state: null,
  get_messages: null,
  set_model: null,
  cycle_model: null,
  get_available_models: null,
  set_thinking_level: null,
  cycle_thinking_level: null,
  get_available_thinking_levels: null,
  set_steering_mode: null,
  set_follow_up_mode: null,
  compact: null,
  set_auto_compaction: null,
  set_auto_retry: null,
  abort_retry: null,
  bash: null,
  abort_bash: null,
  get_session_stats: null,
  get_fork_messages: null,
  get_entries: null,
  get_tree: null,
  get_last_assistant_text: null,
  set_session_name: null,
  get_commands: null,
  new_session: MOVES_FILE,
  switch_session: MOVES_FILE,
  fork: MOVES_FILE,
  clone: MOVES_FILE,
  // An export goes where pi puts it.
  export_html: (command) =>
    command.outputPath === undefined ? null : 'takes no output path on a Host',
}

/** Why a command is refused, or null. A type that is not one of pi's is refused too. */
export function commandRefusal(command: RpcCommand): string | null {
  const type: unknown = (command as { type?: unknown }).type
  if (typeof type !== 'string' || !Object.hasOwn(COMMANDS, type)) return 'not a pi command'
  const rule = COMMANDS[type as RpcCommandType] as CommandRule<RpcCommandType>
  const reason = typeof rule === 'function' ? rule(command) : rule
  return reason === null ? null : `${type} ${reason}`
}
