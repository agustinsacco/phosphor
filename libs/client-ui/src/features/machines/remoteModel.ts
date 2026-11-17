import type { MachineModel, MachineProvider } from '@shared/host-protocol-machine'
import type { ThinkingLevel } from '@shared/rpc'
import { clampThinkingLevel } from '@shared/thinking'
import { availabilityKey, unavailableModels } from '@/lib/modelAvailability'

export interface ModelChoice {
  provider: string
  id: string
}

/**
 * The one rule both Host pickers apply: the new-lane picker over the machine
 * catalogue and a lane's menu over that lane's pi. pi lists only models it can
 * run, so a model is blocked only when the Host's sign-in check reports its
 * provider signed out, or when it is a bare Bedrock id that needs a profile.
 * Blocked models stay listed, disabled, with the reason.
 */
export function hostModelUnavailability(
  models: readonly ModelChoice[],
  providers: readonly MachineProvider[],
  machine = 'this machine',
): Map<string, { detail: string }> {
  const blocked = new Map<string, { detail: string }>(unavailableModels(models))
  for (const model of models) {
    const provider = providers.find((p) => p.id === model.provider)
    if (provider?.status === 'not_ready')
      blocked.set(availabilityKey(model), { detail: `Sign in to ${provider.name} on ${machine}` })
  }
  return blocked
}

/** One source of a new Host lane's model and thinking level. */
export interface StartPreference {
  model?: ModelChoice
  thinking?: ThinkingLevel
}

/**
 * The sources a new Host lane starts from, in the order they win: the last
 * choice for this Host, the Host pi's own default, then This Mac's default
 * (Desktop only). Both shells apply the same order.
 */
export interface RemoteStartPreferences {
  last?: StartPreference
  host?: StartPreference
  desktop?: StartPreference
}

const preferenceOrder = (p: RemoteStartPreferences) => [p.last, p.host, p.desktop]

/**
 * The first preference the Host lists as usable, then signed-in providers'
 * order. A preference the catalogue lacks or blocks falls through.
 */
export function defaultRemoteModel(
  models: readonly MachineModel[],
  providers: readonly MachineProvider[],
  preferences: RemoteStartPreferences = {},
): MachineModel | undefined {
  const blocked = hostModelUnavailability(models, providers)
  const usable = models.filter((m) => !blocked.has(availabilityKey(m)))
  for (const choice of preferenceOrder(preferences).map((p) => p?.model)) {
    const match = usable.find((m) => m.id === choice?.id && m.provider === choice.provider)
    if (match) return match
  }
  for (const provider of providers.filter((p) => p.status === 'ready')) {
    const match = usable.find((m) => m.provider === provider.id)
    if (match) return match
  }
  return usable[0]
}

/** The thinking level by the same order, clamped to what `model` supports. */
export function remoteStartThinking(
  model: MachineModel,
  preferences: RemoteStartPreferences,
): ThinkingLevel {
  const level = preferenceOrder(preferences).find((p) => p?.thinking)?.thinking
  return clampThinkingLevel(model, level ?? 'off')
}

/** Which rule chose `model`, for the chip's tooltip. */
export function remoteModelExplanation(
  model: ModelChoice,
  preferences: RemoteStartPreferences = {},
): string {
  const matches = (preference?: StartPreference) =>
    preference?.model?.provider === model.provider && preference.model.id === model.id
  if (matches(preferences.last)) return 'Using your last selected model for this machine.'
  if (matches(preferences.host)) return 'Using this Host’s default model.'
  if (matches(preferences.desktop)) return 'Using the Desktop default, available on this machine.'
  const fallback = 'Using the first available model; choose another if needed.'
  return preferences.host?.model
    ? `This Host’s default model is not available. ${fallback}`
    : `This Host reports no default model. ${fallback}`
}
