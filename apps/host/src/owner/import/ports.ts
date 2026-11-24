/**
 * What every `owner.migrate.import` section importer (P4b) shares. Each one
 * wraps the daemon's own writer for its section; state.sqlite comes back on
 * abort by itself, anything else through the importer's snapshot.
 */
import type { CallErrorCode } from '@phosphor/shared/host-protocol'
import { OwnerCallRefused } from '../adapter'

export interface ImportPorts {
  /** `<state>`: state.sqlite, routines, artifacts, lane-archive and the sidecars. */
  readonly stateDirectory: string
  /** The Host config; the owner folders file sits beside it. */
  readonly configPath: string
  readonly uid: number | undefined
  /** pi's sessions root, which every archived transcript must sit under. */
  readonly sessionsRoot: string
  log(event: string, fields?: Record<string, unknown>): void
  /**
   * The folder service's queue, when one runs. Standby has none: imports run
   * one at a time on the migration queue, the only writer there.
   */
  serialize?<T>(work: () => Promise<T>): Promise<T>
}

/** A refusal Desktop reads; nothing of the section was written. */
export const refuseImport = (code: CallErrorCode, message: string) =>
  new OwnerCallRefused(code, message)
