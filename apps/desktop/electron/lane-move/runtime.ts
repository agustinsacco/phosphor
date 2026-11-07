import { homedir } from 'node:os'
import { MIN_PI_VERSION } from '@shared/models'
import { transferClaudeVersion } from '@phosphor/session-runtime/lane-transfer/claude-version'
import type { RuntimeProbe } from '@phosphor/session-runtime/lane-transfer/runtime'
import { cachedPiHealth } from '../pi/health'
import { catalogueResult } from '../pi/catalogue'
import { piStubPath } from '../pi/stub'

/** Same version and authoritative model probes as Desktop's setup and pickers. */
export const localTransferRuntime: RuntimeProbe = async (models, cwd) => {
  const stub = piStubPath()
  const health = stub ? null : await cachedPiHealth()
  const catalogue = models ? await catalogueResult() : null
  return {
    piVersion: stub ? MIN_PI_VERSION : health?.ok ? (health.version ?? null) : null,
    claudeVersion: await transferClaudeVersion({ env: process.env, home: homedir() }, cwd),
    models: catalogue?.source === 'pi' ? catalogue.models : null,
  }
}
