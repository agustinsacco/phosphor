import { lstat, open, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { LanePrSignals } from '@phosphor/shared/models'
import { readLinesFrom } from './session-fold'
import {
  emptyPrSignals,
  foldPrEntry,
  mayCarryPrSignal,
  mergeChildSignals,
  prSignalsOf,
  PR_SIGNAL_LIMITS,
  type PrSignalState,
} from './lane-pr-signals'

/**
 * Pull requests a lane's subagents opened. pi-subagents writes each run's
 * transcript to `<session>/<runId>/run-<n>/session.jsonl`, beside the lane's
 * own file, and the lane's entries name those run ids.
 *
 * A fork or rewind copies its parent's entries but not its run folders, so
 * named runs are also looked up in the folders of the session's ancestors.
 * Only folders in the lane's own session directory are ever read, symlinks
 * are refused, and a run is re-read only when its file changes.
 */

const MAX_RUN_BYTES = 32 * 1024 * 1024
const MAX_RUNS = 100
const MAX_ANCESTORS = 4
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface ChildEntry {
  mtimeMs: number
  size: number
  state: PrSignalState
}
const childCache = new Map<string, ChildEntry>()
const CHILDREN_CACHED = 1024

function remember(path: string, entry: ChildEntry): void {
  childCache.delete(path)
  childCache.set(path, entry)
  while (childCache.size > CHILDREN_CACHED) {
    const oldest = childCache.keys().next().value
    if (oldest === undefined) break
    childCache.delete(oldest)
  }
}

/** Test seam. */
export function clearSubagentPrCache(): void {
  childCache.clear()
}

async function directories(path: string, pattern: RegExp): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** The parent named in a session header, if it lives in the same directory. */
async function parentOf(path: string): Promise<string | undefined> {
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const first = buffer.toString('utf8', 0, bytesRead).split('\n', 1)[0] ?? ''
    const parent = (JSON.parse(first) as { parentSession?: unknown }).parentSession
    return typeof parent === 'string' && dirname(parent) === dirname(path) ? parent : undefined
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

async function childSignals(path: string): Promise<PrSignalState | null> {
  let info
  try {
    info = await lstat(path)
  } catch {
    return null
  }
  if (!info.isFile() || info.size > MAX_RUN_BYTES) return null
  const cached = childCache.get(path)
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.state
  const state = emptyPrSignals()
  try {
    await readLinesFrom(
      path,
      0,
      (line) => {
        if (!mayCarryPrSignal(line, state)) return
        try {
          foldPrEntry(state, JSON.parse(line) as Record<string, unknown>, line, { mentions: false })
        } catch {
          // A run being written can end mid-record.
        }
      },
      MAX_RUN_BYTES,
    )
  } catch {
    return null
  }
  remember(path, { mtimeMs: info.mtimeMs, size: info.size, state })
  return state
}

/** Transcripts of the runs this lane started or names, oldest folder last. */
async function runTranscripts(
  lanePath: string,
  parentSession: string | undefined,
  runIds: ReadonlySet<string>,
): Promise<string[]> {
  const folder = (path: string): string => join(dirname(path), basename(path, '.jsonl'))
  const runDirs = (await directories(folder(lanePath), RUN_ID)).map((id) =>
    join(folder(lanePath), id),
  )
  let ancestor = dirname(parentSession ?? '') === dirname(lanePath) ? parentSession : undefined
  for (let depth = 0; ancestor && depth < MAX_ANCESTORS && runIds.size; depth++) {
    for (const id of await directories(folder(ancestor), RUN_ID))
      if (runIds.has(id)) runDirs.push(join(folder(ancestor), id))
    ancestor = await parentOf(ancestor)
  }
  const files: string[] = []
  for (const dir of runDirs.slice(0, MAX_RUNS))
    for (const run of await directories(dir, /^run-\d{1,3}$/))
      files.push(join(dir, run, 'session.jsonl'))
  return files.slice(0, MAX_RUNS)
}

/**
 * The lane's own signals plus its subagents'. Pins, hides and mentions stay
 * the lane's own; children only add PRs they opened, pushed or reviewed.
 */
export async function withSubagentPrs(
  lanePath: string,
  parentSession: string | undefined,
  own: PrSignalState,
): Promise<LanePrSignals | undefined> {
  const files = await runTranscripts(lanePath, parentSession, own.runs)
  if (!files.length) return prSignalsOf(own)
  const merged: PrSignalState = { ...own, runs: new Set(), pending: new Set() }
  merged.opened = new Map(own.opened)
  merged.branches = new Set(own.branches)
  merged.reviewing = new Map(own.reviewing)
  merged.reviewingHere = new Set(own.reviewingHere)
  for (const file of files) {
    const child = await childSignals(file)
    if (child) mergeChildSignals(merged, child)
    if (merged.opened.size >= PR_SIGNAL_LIMITS.opened) break
  }
  return prSignalsOf(merged)
}
