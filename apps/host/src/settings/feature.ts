import { parseSettingsRead } from '@phosphor/shared/machine-settings'
import type { HostFeature } from '../features/feature'
import type { SettingsContext } from './context'
import type { SettingsSnapshot } from './snapshot'
import { SettingsFailure } from './files'
import { checkConnectors } from './connector-check'
import { applySettings } from './mutation'

async function settingsCall(
  state: SettingsContext,
  snapshot: SettingsSnapshot,
  method: string,
  params: unknown,
  authorized: () => boolean,
) {
  try {
    return await state.options.accounts.withAuthorization(authorized, async () => {
      if (!authorized()) throw new SettingsFailure('forbidden', 'Configuration access was revoked.')
      const read = parseSettingsRead(params)
      if (method === 'machine.settings.check') await checkConnectors(state, read, authorized)
      const data =
        method === 'machine.settings.patch'
          ? await applySettings(state, snapshot, params, authorized)
          : read
            ? await snapshot(read.section, read.repositoryId)
            : null
      if (!data) throw new SettingsFailure('bad-request', 'Invalid settings request.')
      return { ok: true as const, data }
    })
  } catch (error) {
    return {
      ok: false as const,
      error: {
        code: error instanceof SettingsFailure ? error.code : ('internal' as const),
        message:
          error instanceof SettingsFailure
            ? error.message
            : 'Host settings could not be read or changed.',
      },
    }
  }
}

export function createSettingsFeature(
  state: SettingsContext,
  snapshot: SettingsSnapshot,
): HostFeature {
  let pending = 0
  let tail: Promise<unknown> = Promise.resolve()
  return {
    capability: 'machine.configure',
    methods: ['machine.settings.read', 'machine.settings.patch', 'machine.settings.check'],
    async call(method, params, authorized = () => false) {
      if (!authorized())
        return {
          ok: false,
          error: { code: 'forbidden', message: 'Configuration access is not granted.' },
        }
      if (pending >= 8)
        return { ok: false, error: { code: 'internal', message: 'Settings are busy. Try again.' } }
      pending++
      const run = tail
        .catch(() => {})
        .then(() => settingsCall(state, snapshot, method, params, authorized))
        .finally(() => {
          pending--
        })
      tail = run
      return run
    },
  }
}
