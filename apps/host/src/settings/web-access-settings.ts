import { existsSync } from 'node:fs'
import type { MachineSettings, MachineSettingsChange } from '@phosphor/shared/machine-settings'
import { configuredWebAccessKeys } from '@phosphor/shared/web-access'
import { webSearchConfigPath } from '@phosphor/session-runtime/pi/pi-paths'
import {
  HOST_FILE_POLICY,
  saveSettingsFile,
  SettingsFailure,
  settingsFile,
  withSettingsFileLock,
} from '@phosphor/session-runtime/pi/settings-file'
import type { SettingsContext } from './context'

type WebAccess = NonNullable<NonNullable<MachineSettings['resources']>['webAccess']>
type WebAccessChange = Extract<MachineSettingsChange, { type: 'webAccess.key' }>

/** pi-web-access's config, where the Host's lanes look for it (their pi environment). */
export const webAccessPath = (state: SettingsContext): string =>
  webSearchConfigPath(state.options.env, state.options.context.home)

/**
 * Which provider keys are configured, by name; the values never leave this
 * file. A file the Host will not edit (malformed, a link, too large) reads as
 * malformed, so the rest of the resources section still loads.
 */
export function readWebAccessSettings(state: SettingsContext): WebAccess {
  const path = webAccessPath(state)
  try {
    const file = settingsFile(path, HOST_FILE_POLICY)
    return {
      configured: configuredWebAccessKeys(file.raw),
      exists: existsSync(path),
      malformed: false,
    }
  } catch (error) {
    if (!(error instanceof SettingsFailure)) throw error
    return { configured: [], exists: true, malformed: true }
  }
}

/** Set or clear one key, preserving every other setting; saved 0600 like all Host config. */
export async function changeWebAccessSettings(
  state: SettingsContext,
  change: WebAccessChange,
  revision: string,
  commitAllowed: () => boolean,
): Promise<void> {
  const path = webAccessPath(state)
  await withSettingsFileLock(path, async () => {
    if (state.revision('resources') !== revision)
      throw new SettingsFailure('bad-request', 'Settings changed. Reload before saving.')
    const file = settingsFile(path, HOST_FILE_POLICY)
    const next = { ...file.raw }
    if (change.value === null) delete next[change.key]
    else next[change.key] = change.value
    await saveSettingsFile(path, next, file.revision, commitAllowed, HOST_FILE_POLICY)
  })
}
