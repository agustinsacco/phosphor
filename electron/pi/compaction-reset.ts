import { join } from 'node:path'
import { errorText } from '@shared/errors'
import { log } from '../debug-log'
import { isCompactionResetChecked, markCompactionResetChecked } from '../store'
import { patchAgentSettings } from './agent-settings'
import { readJsonFile } from './json-config'
import { piAgentDir } from './pi-paths'

/**
 * One-time repair of pi's global `compaction.enabled`.
 *
 * Until pi owned compaction for every provider, Phosphor sent
 * `set_auto_compaction` at every spawn and model switch: off for Claude, whose
 * CLI compacted by itself, and on for everything else. pi saves that command
 * to its global settings.json, so an install whose last session ran on Claude
 * was left with `false`. Phosphor no longer sends it, and pi-claude-cli 0.9.0
 * turns the CLI's own compaction off, so that leftover would mean nothing
 * compacts any session, on any provider.
 *
 * The value cannot say who wrote it, and the old behaviour rewrote it at every
 * session start, so it is reset unconditionally, once. A `false` set after
 * this check is the user's and is left alone. Only the global file is read,
 * because it is the only one `set_auto_compaction` writes.
 */
export async function resetLeftoverCompaction(marker: {
  done(): boolean
  markDone(): void
}): Promise<'reset' | 'unchanged' | 'already-checked'> {
  if (marker.done()) return 'already-checked'
  const read = await readJsonFile<{ compaction?: { enabled?: unknown } }>(
    join(piAgentDir(), 'settings.json'),
  )
  // Left unmarked, so the check runs again once the user has fixed the file.
  if (read.malformed) {
    throw new Error(`pi settings.json is not valid JSON (${read.error ?? 'parse error'})`)
  }
  const leftover = read.value.compaction?.enabled === false
  if (leftover) await patchAgentSettings('global', undefined, { compaction: { enabled: true } })
  marker.markDone()
  return leftover ? 'reset' : 'unchanged'
}

let once: Promise<void> | undefined

/**
 * The check, at most once per launch. Awaited before the first pi process
 * starts, since pi reads its settings at startup. Never rejects: a failed
 * check is logged and tried again next launch.
 */
export function ensureCompactionReset(): Promise<void> {
  once ??= resetLeftoverCompaction({
    done: isCompactionResetChecked,
    markDone: markCompactionResetChecked,
  })
    .then((outcome) => {
      if (outcome === 'reset') {
        log('pi', 'turned pi auto-compaction back on (left off by an older Phosphor)')
      }
    })
    .catch((error: unknown) => {
      log('pi', 'compaction reset skipped', { error: errorText(error) })
    })
  return once
}
