import { access, readFile, rm } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import type { SessionTree } from '@phosphor/shared/ipc'
import { forkClaudeLedgerForClone } from '@phosphor/session-runtime/claude/ledger'
import { readSessionTree } from '@phosphor/session-runtime/pi/session-tree'
import * as writer from '@phosphor/session-runtime/pi/session-writer'
import type { OpPrincipal } from '@phosphor/session-runtime/ops/types'
import { laneIdInRef } from '../ops/lane-ref'
import type { HostRuntime } from '../session/runtime'
import { LaneCapacityReached, type HostStore, type StoredLane } from './store'

/**
 * Lane editing on the daemon: the conversation tree, labels, branch jumps,
 * and fork, clone and rewind into a new lane. Every byte goes through
 * session-runtime's writer, so a transcript edited here is the same file
 * Desktop writes. Labels and jumps change the lane's own file, so they run
 * only while no pi owns it. Fork, clone and rewind only read the source (its
 * complete lines) into a fresh file, so they run live or not and the source
 * lane is left as it was. The Host never sends pi's own `fork` or `clone`:
 * it must always know which file each pi writes.
 */

export interface LaneEditingRuntime {
  /** The runtime's path lock: refused while a pi owns the file, or shared with a live owner. */
  readonly runtime: Pick<HostRuntime, 'mutateStoppedSession' | 'withSessionFile'>
  /** Publishes a lane editing created to the lanes topic. */
  readonly announce: (laneId: string) => void
}

export interface LaneEditingPorts extends LaneEditingRuntime {
  readonly store: HostStore
  /** `state.sqlite`, for the new lane's `lane_prefs`. */
  readonly db: DatabaseSync
}

/** A request lane editing refuses; the text says what to do instead. */
export class LaneEditRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LaneEditRefused'
  }
}

const NO_FILE = 'This lane has no saved conversation yet. Send a first message, then try again.'
const MISSING = 'This lane’s saved conversation no longer exists. It may have been deleted.'
const FULL = 'This machine has reached its lane limit. Archive or delete a lane, then try again.'

function sessionFileOf(lane: StoredLane): string {
  if (lane.sessionFile === null) throw new LaneEditRefused(NO_FILE)
  return lane.sessionFile
}

/** An append recreates a missing file, so a deletion that ran first must stop the edit here. */
async function assertExists(path: string): Promise<void> {
  try {
    await access(path)
  } catch {
    throw new LaneEditRefused(MISSING)
  }
}

function entryIn(tree: SessionTree, id: string) {
  const entry = tree.entries.find((e) => e.id === id)
  if (!entry) throw new LaneEditRefused(`No entry ${id} in this lane’s conversation.`)
  return entry
}

/** The lane's conversation tree, read from its saved file. A live lane reads as far as pi has written. */
export async function readLaneTree(lane: StoredLane): Promise<SessionTree> {
  const file = sessionFileOf(lane)
  await assertExists(file)
  return readSessionTree(file)
}

/** The label `entry` carries now: the last label entry aimed at it, undefined once cleared or never set. */
export function labelOf(tree: SessionTree, entry: string): string | undefined {
  let label: string | undefined
  for (const e of tree.entries) if (e.type === 'label' && e.targetId === entry) label = e.label
  return label
}

/** Labels (or, with no label, clears) `entry`; answers the label it had before. */
export function labelLaneEntry(
  ports: LaneEditingPorts,
  lane: StoredLane,
  entry: string,
  label: string | undefined,
): Promise<{ readonly previous: string | undefined }> {
  const file = sessionFileOf(lane)
  return ports.runtime.mutateStoppedSession(file, async () => {
    await assertExists(file)
    const tree = await readSessionTree(file)
    entryIn(tree, entry)
    const previous = labelOf(tree, entry)
    await writer.appendLabel(file, entry, label)
    return { previous }
  })
}

/** Moves the lane's leaf to `entry`, where its next resume continues; answers the leaf it had. */
export function jumpLaneTo(
  ports: LaneEditingPorts,
  lane: StoredLane,
  entry: string,
): Promise<{ readonly previousLeaf: string | null }> {
  const file = sessionFileOf(lane)
  return ports.runtime.mutateStoppedSession(file, async () => {
    await assertExists(file)
    const tree = await readSessionTree(file)
    entryIn(tree, entry)
    await writer.appendBranchJump(file, entry)
    return { previousLeaf: tree.leafId }
  })
}

/** Whether the lane still continues from `entry` as a jump left it: its leaf is that jump's branch summary. */
export async function jumpIsCurrent(lane: StoredLane, entry: string): Promise<boolean> {
  const tree = await readLaneTree(lane)
  const leaf = tree.entries.find((e) => e.id === tree.leafId)
  return leaf?.type === 'branch_summary' && leaf.parentId === entry
}

export type LaneForkKind = 'fork' | 'clone' | 'rewind'

/** Owner facts for a lane an agent created: who, and how many agent-created lanes sit above it. */
export interface LaneLineage {
  readonly createdBy: string
  readonly lineage: number
}

function storedLineage(db: DatabaseSync, laneId: string): number {
  const row = db
    .prepare(`SELECT value FROM lane_prefs WHERE lane_id=? AND key='lineage'`)
    .get(laneId)
  const lineage = Number(row?.value)
  return Number.isSafeInteger(lineage) && lineage >= 0 ? lineage : 0
}

/**
 * The `created_by` and `lineage` a lane created for `asker` records, or null
 * for a lane the user started (a surface, or the CLI outside any lane). An
 * agent's new lane sits one below the deepest lineage it is known by.
 */
export function laneLineage(asker: OpPrincipal, db: DatabaseSync): LaneLineage | null {
  switch (asker.kind) {
    case 'agent': {
      const above = Math.max(asker.lineage, storedLineage(db, laneIdInRef(asker.laneRef)))
      return { createdBy: asker.laneRef, lineage: above + 1 }
    }
    case 'local':
      if (asker.lane === undefined) return null
      return {
        createdBy: asker.lane,
        lineage: storedLineage(db, laneIdInRef(asker.lane)) + 1,
      }
    case 'machine':
      return { createdBy: `machine:${asker.machineId}`, lineage: 1 }
    case 'surface':
      return null
  }
}

/** pi's `extractUserMessageText`: the text parts, joined with nothing. */
function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('')
}

/** The text of the user message `id` in the file, as pi's own fork hands it back. */
async function userMessageText(file: string, id: string): Promise<string> {
  const needle = JSON.stringify(id)
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.includes(needle)) continue
    try {
      const entry = JSON.parse(line) as { id?: unknown; message?: { content?: unknown } }
      if (entry.id === id) return userText(entry.message?.content)
    } catch {
      continue
    }
  }
  return ''
}

/** Where the new file's leaf goes, and what a rewind hands back for the composer. */
async function forkTarget(
  file: string,
  tree: SessionTree,
  kind: LaneForkKind,
  at: string | undefined,
): Promise<{ readonly targetId: string | null; readonly prefill?: string }> {
  if (kind === 'rewind') {
    const entry = entryIn(tree, at ?? '')
    if (entry.type !== 'message' || entry.role !== 'user')
      throw new LaneEditRefused('Rewind goes back to one of your messages; pick a user message.')
    return { targetId: entry.parentId, prefill: await userMessageText(file, entry.id) }
  }
  if (tree.leafId === null)
    throw new LaneEditRefused('This lane’s conversation has no entries to copy yet.')
  if (kind === 'clone' && at !== undefined && at !== tree.leafId)
    throw new LaneEditRefused(
      'Clone copies the whole conversation; use lane.fork to branch at an entry.',
    )
  return { targetId: at === undefined ? tree.leafId : entryIn(tree, at).id }
}

function writePrefs(db: DatabaseSync, laneId: string, prefs: Readonly<Record<string, string>>) {
  const insert = db.prepare(
    'INSERT INTO lane_prefs(lane_id, key, value) VALUES (?,?,?) ON CONFLICT(lane_id, key) DO UPDATE SET value=excluded.value',
  )
  for (const [key, value] of Object.entries(prefs)) insert.run(laneId, key, value)
}

function prefsFor(
  kind: LaneForkKind,
  source: StoredLane,
  lineage: LaneLineage | null,
): Record<string, string> {
  return {
    ...(kind === 'rewind' ? { rewound_from: source.laneId } : {}),
    ...(lineage ? { created_by: lineage.createdBy, lineage: String(lineage.lineage) } : {}),
  }
}

/** The new file as a stopped lane beside the source: same folder, worktree, title and model. */
function storeForkedLane(store: HostStore, source: StoredLane, file: string): StoredLane {
  try {
    return store.ensureLane({
      repositoryId: source.repositoryId,
      cwd: source.cwd,
      sessionFile: file,
      worktree: source.worktree,
      title: source.title,
      branch: source.branch,
      provider: source.model?.provider ?? null,
      model: source.model?.id ?? null,
    })
  } catch (error) {
    if (error instanceof LaneCapacityReached) throw new LaneEditRefused(FULL)
    throw error
  }
}

export interface LaneForked {
  readonly lane: StoredLane
  /** Rewind: the message's text, for the composer. */
  readonly prefill?: string
  /** Clone: the Claude CLI ledger was forked with the conversation. */
  readonly ledgerForked?: boolean
}

/**
 * Fork (at an entry, the leaf by default), clone (at the leaf, with the
 * Claude ledger) or rewind (to just before a user message) into a NEW lane.
 * The source lane, live or stopped, keeps its file. A rewind records the lane
 * it replaced; an agent's new lane records its lineage, or it is not kept.
 */
export async function forkLane(
  ports: LaneEditingPorts,
  source: StoredLane,
  request: {
    readonly kind: LaneForkKind
    readonly at?: string
    readonly lineage: LaneLineage | null
  },
): Promise<LaneForked> {
  const file = sessionFileOf(source)
  const forked = await ports.runtime.withSessionFile(file, async () => {
    await assertExists(file)
    const target = await forkTarget(file, await readSessionTree(file), request.kind, request.at)
    return { file: await writer.forkSessionAt(file, target.targetId), prefill: target.prefill }
  })
  let lane: StoredLane | undefined
  try {
    lane = storeForkedLane(ports.store, source, forked.file)
    writePrefs(ports.db, lane.laneId, prefsFor(request.kind, source, request.lineage))
  } catch (error) {
    // No one knows the new file yet: an unrecorded fork leaves nothing behind.
    if (lane) ports.store.markRemoved(lane.laneId)
    await rm(forked.file, { force: true })
    throw error
  }
  const ledgerForked =
    request.kind === 'clone'
      ? await forkClaudeLedgerForClone(forked.file).catch(() => false)
      : undefined
  ports.announce(lane.laneId)
  return {
    lane,
    ...(forked.prefill !== undefined ? { prefill: forked.prefill } : {}),
    ...(ledgerForked !== undefined ? { ledgerForked } : {}),
  }
}
