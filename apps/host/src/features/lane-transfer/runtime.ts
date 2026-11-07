import { parseMachineModels } from '@phosphor/shared/host-protocol-machine'
import { transferClaudeVersion } from '@phosphor/session-runtime/lane-transfer/claude-version'
import type { RuntimeProbe } from '@phosphor/session-runtime/lane-transfer/runtime'
import type { FeatureContext } from '../feature'
import { featureInspection, queryMachine } from '../machine'

/** Host-configured pi and environment only; the client never supplies a binary or env. */
export function hostTransferRuntime(context: FeatureContext, configPath: string): RuntimeProbe {
  return async (models, cwd) => {
    const inspection = await featureInspection(context, { configPath })
    const raw =
      models && inspection.pi
        ? await queryMachine(inspection.pi, cwd ?? context.home, 'get_available_models')
        : null
    return {
      piVersion: inspection.piVersion,
      claudeVersion: await transferClaudeVersion(context, cwd),
      models: raw === null ? null : parseMachineModels(raw),
    }
  }
}
