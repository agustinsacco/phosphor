import type { MachineModel } from '@phosphor/shared/host-protocol-machine'

/** Only user-declared models are knowable without pi. File admission stays with the caller. */
export function configModels(providers: unknown): MachineModel[] {
  if (!providers || typeof providers !== 'object') return []

  const models: MachineModel[] = []
  for (const [provider, config] of Object.entries(providers as Record<string, unknown>)) {
    if (!config || typeof config !== 'object') continue
    const { models: list, compat } = config as {
      models?: unknown
      compat?: { supportsReasoningEffort?: boolean }
    }
    if (!Array.isArray(list)) continue
    const reasoning = compat?.supportsReasoningEffort !== false
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const { id, name, contextWindow, thinkingLevelMap } = entry as {
        id?: unknown
        name?: unknown
        contextWindow?: unknown
        thinkingLevelMap?: MachineModel['thinkingLevelMap']
      }
      if (typeof id !== 'string' || id.length === 0) continue
      models.push({
        id,
        name: typeof name === 'string' && name ? name : id,
        provider,
        reasoning,
        ...(typeof contextWindow === 'number' &&
        Number.isSafeInteger(contextWindow) &&
        contextWindow > 0
          ? { contextWindow }
          : {}),
        // Passed through when the user declared it in models.json, so the
        // home picker's level derivation stays per-model even on fallback.
        thinkingLevelMap: typeof thinkingLevelMap === 'object' ? thinkingLevelMap : undefined,
      })
    }
  }
  return models
}
