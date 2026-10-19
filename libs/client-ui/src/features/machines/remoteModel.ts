import type { MachineModel, MachineProvider } from '@shared/host-protocol-machine'

export interface ModelChoice {
  provider: string
  id: string
}

/** Preserve provider catalogue order as a fallback; it is not a configured Host default. */
export function defaultRemoteModel(
  models: readonly MachineModel[],
  providers: readonly MachineProvider[],
  last?: ModelChoice,
  desktop?: ModelChoice,
): MachineModel | undefined {
  const usable = models.filter((m) =>
    providers.some((p) => p.id === m.provider && p.status === 'ready'),
  )
  for (const choice of [last, desktop]) {
    const match = usable.find((m) => m.id === choice?.id && m.provider === choice.provider)
    if (match) return match
  }
  for (const provider of providers) {
    const match = usable.find((m) => m.provider === provider.id)
    if (match) return match
  }
  return undefined
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
