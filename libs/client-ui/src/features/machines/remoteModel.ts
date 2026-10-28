import type { MachineModel, MachineProvider } from '@shared/host-protocol-machine'
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

/** Signed-in providers' order first; it is a fallback, not a configured Host default. */
export function defaultRemoteModel(
  models: readonly MachineModel[],
  providers: readonly MachineProvider[],
  last?: ModelChoice,
  desktop?: ModelChoice,
): MachineModel | undefined {
  const blocked = hostModelUnavailability(models, providers)
  const usable = models.filter((m) => !blocked.has(availabilityKey(m)))
  for (const choice of [last, desktop]) {
    const match = usable.find((m) => m.id === choice?.id && m.provider === choice.provider)
    if (match) return match
  }
  for (const provider of providers.filter((p) => p.status === 'ready')) {
    const match = usable.find((m) => m.provider === provider.id)
    if (match) return match
  }
  return usable[0]
}

/** Explain the existing precedence without claiming the Host exposes default-model metadata. */
export function remoteModelExplanation(
  model: ModelChoice,
  last?: ModelChoice,
  desktop?: ModelChoice,
): string {
  const matches = (choice?: ModelChoice) =>
    choice?.provider === model.provider && choice.id === model.id
  if (matches(last)) return 'Using your last selected model for this machine.'
  if (matches(desktop)) return 'Using the Desktop default, available on this machine.'
  return 'The Host does not expose a default model. Using the first available model; choose another if needed.'
}
