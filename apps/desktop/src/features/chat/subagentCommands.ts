export type SubagentCommand =
  'subagents-inspect-rpc' | 'subagents-stop' | 'subagents-steer' | 'phosphor-save-subagent-snapshot'

/** Do not let a missing extension command fall through to a model prompt. */
export async function requireSubagentCommand(
  sessionId: string,
  name: SubagentCommand,
): Promise<void> {
  const response = await window.phosphor.piCommand(sessionId, { type: 'get_commands' })
  if (
    !response.success ||
    !response.data?.commands.some((c) => c.name === name && c.source === 'extension')
  ) {
    throw new Error(`This session does not support /${name}.`)
  }
}
