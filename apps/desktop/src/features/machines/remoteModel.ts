import type { MachineModel, MachineProvider } from '@shared/host-protocol-machine'

export interface ModelChoice {
  provider: string
  id: string
}

/** Catalogue order is the Host's recommendation when it has no explicit default metadata. */
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
