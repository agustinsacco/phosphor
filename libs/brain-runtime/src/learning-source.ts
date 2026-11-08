import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { BrainLearningSource } from '@phosphor/shared/brain-learning'

const MAX_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 200_000
const ENTRY_TYPES = new Set([
  'message',
  'model_change',
  'thinking_level_change',
  'usage',
  'compaction',
  'context_edit',
  'branch_summary',
  'custom',
  'custom_message',
  'label',
  'session_info',
])
const MESSAGE_ROLES = new Set([
  'system',
  'user',
  'assistant',
  'toolResult',
  'bashExecution',
  'custom',
  'branchSummary',
  'compactionSummary',
])
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
export interface LearningSelection {
  sessionId: string
  selectedLeafId: string
}
export interface LearningSourceState extends LearningSelection {
  /** Host attests no streaming, queues, retries, compaction, pending tools or startup. */
  settled: boolean
  fence: string
}
interface Entry {
  type: string
  id: string
  parentId: string | null
  [key: string]: unknown
}
export interface FrozenLearningSource {
  source: BrainLearningSource
  header: Record<string, unknown>
  lines: string[]
}
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Malformed learning source')
  return raw as Record<string, unknown>
}
/** No compaction/projection here: only pi may decide which history reaches the model. */
export function freezeLearningSource(
  text: string,
  selection: LearningSelection,
): FrozenLearningSource {
  if (Buffer.byteLength(text) > MAX_BYTES || !text.endsWith('\n'))
    throw new Error('Oversized or torn learning source')
  const lines = text.slice(0, -1).split('\n')
  if (lines.length > MAX_ENTRIES + 1) throw new Error('Oversized learning source')
  const header = record(JSON.parse(lines.shift()!))
  if (header.type !== 'session' || header.version !== 3 || header.id !== selection.sessionId)
    throw new Error('Unsupported learning source identity/version')
  const byId = new Map<string, { entry: Entry; line: string }>()
  for (const line of lines) {
    const raw = record(JSON.parse(line))
    if (
      typeof raw.id !== 'string' ||
      !raw.id ||
      typeof raw.type !== 'string' ||
      !(raw.parentId === null || typeof raw.parentId === 'string') ||
      byId.has(raw.id)
    )
      throw new Error('Malformed learning source ancestry')
    if (
      !ENTRY_TYPES.has(raw.type) ||
      (raw.type === 'message' && !MESSAGE_ROLES.has(String(record(raw.message).role)))
    )
      throw new Error('Unsupported learning source entry or message role')
    byId.set(raw.id, { entry: raw as Entry, line })
  }
  const chain: Array<{ entry: Entry; line: string }> = []
  const visited = new Set<string>()
  let id: string | null = selection.selectedLeafId
  while (id !== null) {
    const item = byId.get(id)
    if (!item || visited.has(id)) throw new Error('Missing or cyclic learning source ancestry')
    visited.add(id)
    chain.push(item)
    id = item.entry.parentId
  }
  chain.reverse()
  if (!chain.length) throw new Error('Missing learning source leaf')
  const entries = chain.map(({ entry }) => {
    const entryHash = digest(JSON.stringify(entry))
    // pi re-chains labels on native forks. That must not manufacture independent roots.
    const { parentId, ...contribution } = entry
    return { entryId: entry.id, parentId, entryHash, rootId: digest(JSON.stringify(contribution)) }
  })
  return {
    header,
    lines: chain.map((item) => item.line),
    source: {
      ...selection,
      sourceDigest: digest(text),
      contentDigest: digest(JSON.stringify(entries)),
      entries,
    },
  }
}
async function readSource(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_BYTES)
      throw new Error('Unsafe or oversized learning source')
    const bytes = Buffer.alloc(MAX_BYTES + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > MAX_BYTES) throw new Error('Oversized learning source')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))
  } finally {
    await file.close()
  }
}
function assertSettled(state: LearningSourceState, selection: LearningSelection): void {
  if (
    !state.settled ||
    !state.fence ||
    state.sessionId !== selection.sessionId ||
    state.selectedLeafId !== selection.selectedLeafId
  )
    throw new Error('Learning source is not settled at selected leaf')
}
/** Caller holds the existing session path lock throughout; inspect rechecks its owner fence.
 * snapshotPath must be inside the caller's private job directory, never the source path.
 */
export async function writeLearningSnapshot(options: {
  sourcePath: string
  snapshotPath: string
  selection: LearningSelection
  inspect(): Promise<LearningSourceState>
}): Promise<FrozenLearningSource> {
  const { sourcePath, snapshotPath, inspect } = options
  const selection = { ...options.selection }
  if (resolve(sourcePath) === resolve(snapshotPath))
    throw new Error('Learning snapshot must be private')
  const first = await inspect()
  assertSettled(first, selection)
  const text = await readSource(sourcePath)
  const frozen = freezeLearningSource(text, selection)
  const last = await inspect()
  assertSettled(last, selection)
  if (first.fence !== last.fence || (await readSource(sourcePath)) !== text)
    throw new Error('Learning source changed during snapshot')
  // wx refuses existing files and symlinks. Original entries remain byte-for-byte intact.
  const file = await open(snapshotPath, 'wx', 0o600)
  try {
    const header = { ...frozen.header, id: randomUUID(), parentSession: sourcePath }
    await file.writeFile([JSON.stringify(header), ...frozen.lines, ''].join('\n'))
    await file.sync()
  } catch (error) {
    await file.close()
    await unlink(snapshotPath)
    throw error
  }
  await file.close()
  if (!(await lstat(snapshotPath)).isFile()) throw new Error('Learning snapshot unavailable')
  return frozen
}
