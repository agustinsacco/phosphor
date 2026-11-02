/** Explicit, bounded copies of an already-read inspection, not a live run registry. */
export const SNAPSHOT_COMMAND = 'phosphor-save-subagent-snapshot'
export const SNAPSHOT_WIDGET = 'phosphor-subagent-save'
export const SNAPSHOT_PREFIX = 'PHOSPHOR_SUBAGENT_SAVE:'
export const SNAPSHOT_LIMIT = 100_000

export interface InspectionSnapshot {
  /**
   * pi's id for the inspected session. A Host lane's window knows only its own handle
   * and omits it: the session that runs the save command is then the source.
   */
  sourceSessionId?: string
  runId: string
  childId?: string
  readAt: string
  inspection: {
    label?: string
    status?: string
    task?: string
    finalOutput?: string
    messages: { role: string; text: string }[]
    truncated: boolean
  }
}

export const validTargetId = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,255}$/.test(id)

/** Keep captured text literal, including any Markdown fences it contains. */
const literal = (text: string): string => {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)))
  return `${fence}text\n${text}\n${fence}`
}

export function snapshotContent(value: unknown, sessionId: string): string {
  if (!value || typeof value !== 'object') throw new Error('Invalid snapshot.')
  const s = value as InspectionSnapshot
  if (s.sourceSessionId !== undefined && s.sourceSessionId !== sessionId)
    throw new Error('Snapshot belongs to another session.')
  if (!validTargetId(s.runId) || (s.childId !== undefined && !validTargetId(s.childId)))
    throw new Error('Invalid snapshot target.')
  if (typeof s.readAt !== 'string' || !Number.isFinite(Date.parse(s.readAt)))
    throw new Error('Invalid capture time.')
  const i = s.inspection
  if (
    !i ||
    !Array.isArray(i.messages) ||
    i.messages.length > 200 ||
    typeof i.truncated !== 'boolean'
  )
    throw new Error('Invalid inspection.')
  for (const field of [i.label, i.status, i.task, i.finalOutput])
    if (field !== undefined && typeof field !== 'string')
      throw new Error('Invalid inspection text.')
  if (JSON.stringify(value).length > SNAPSHOT_LIMIT) throw new Error('Snapshot is too large.')
  const messages = i.messages.map((m) => {
    if (!m || typeof m.role !== 'string' || typeof m.text !== 'string')
      throw new Error('Invalid inspection message.')
    return literal(`${m.role}\n${m.text}`)
  })
  const content = [
    '# Saved subagent snapshot',
    'An explicit copy of a read-only inspection. This is not current status or a complete transcript. Execution completion is not acceptance.',
    literal(
      `Session: ${sessionId}\nRun: ${s.runId}${s.childId ? `\nChild: ${s.childId}` : ''}\nRead at: ${s.readAt}\nLabel: ${i.label ?? 'unavailable'}\nReported run state: ${i.status ?? 'unavailable'}`,
    ),
    s.childId ? 'The reported state can describe the containing run, not this child.' : '',
    i.truncated
      ? '**Bounded preview: content was omitted from the original inspection.**'
      : 'This captures only the returned inspection window.',
    ...(i.task ? ['## Delegated task', literal(i.task)] : []),
    '## Messages',
    ...messages,
    ...(i.finalOutput ? ['## Result at read time', literal(i.finalOutput)] : []),
  ]
    .filter(Boolean)
    .join('\n\n')
  if (content.length > SNAPSHOT_LIMIT) throw new Error('Formatted snapshot is too large.')
  return content
}

/**
 * Whether a save receipt holds exactly this snapshot. Without a named source, the
 * receipt names the session that saved it, and the whole content is rebuilt around
 * that name: a wrong name can only fail the match.
 */
export function snapshotReceiptMatches(snapshot: InspectionSnapshot, content: unknown): boolean {
  if (typeof content !== 'string') return false
  const session = snapshot.sourceSessionId ?? /^Session: (\S+)$/m.exec(content)?.[1]
  if (session === undefined) return false
  try {
    return content === snapshotContent(snapshot, session)
  } catch {
    return false
  }
}
