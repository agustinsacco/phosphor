import type { CliContext, CliIo } from './cli-handlers'

/** The command table's own path: parse, check and dispatch, or refuse with usage. */
export type CommandTable = (
  argv: readonly string[],
  io: CliIo,
  context: CliContext,
) => Promise<number>

/**
 * `phosphor <domain> <op> ...`: argv whose first word the command table does
 * not know. Catalog ops are not served by this build, so it answers exactly
 * as the command table does: the unknown-command usage refusal, or help.
 */
export function runCliOps(
  argv: readonly string[],
  io: CliIo,
  context: CliContext,
  commandTable: CommandTable,
): Promise<number> {
  return commandTable(argv, io, context)
}
