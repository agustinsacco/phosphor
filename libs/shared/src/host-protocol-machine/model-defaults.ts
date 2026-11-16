import type { ThinkingLevel } from '../rpc'
import { ALL_THINKING_LEVELS } from '../thinking'

/**
 * The Host pi's own new-session defaults, as its global `settings.json` sets
 * them: `defaultProvider` with `defaultModel`, and `defaultThinkingLevel`.
 * They ride the `machine.models` answer under `skills.read`, so a client reads
 * them without `machine.configure`; an older Host leaves them out. Nothing else
 * from the Host's settings crosses.
 */
export interface MachineModelDefaults {
  model?: { provider: string; id: string }
  thinkingLevel?: ThinkingLevel
}

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0')
const thinkingLevel = (v: unknown) => ALL_THINKING_LEVELS.find((level) => level === v)

/** The same bounds as a catalogue model's `provider` and `id`. */
function modelChoice(provider: unknown, id: unknown): MachineModelDefaults['model'] | null {
  return text(provider, 64) && text(id, 200) ? { provider, id } : null
}

/**
 * The Host's projection of pi's settings: a model only when both ids are set,
 * as pi needs both to start on it. Undefined when neither default is set.
 */
export function machineModelDefaults(
  settings: Record<string, unknown>,
): MachineModelDefaults | undefined {
  const model = modelChoice(settings.defaultProvider, settings.defaultModel)
  const level = thinkingLevel(settings.defaultThinkingLevel)
  if (!model && !level) return undefined
  return { ...(model ? { model } : {}), ...(level ? { thinkingLevel: level } : {}) }
}

/** Exactly `model {provider, id}` and `thinkingLevel`, each optional; anything else is null. */
export function parseMachineModelDefaults(v: unknown): MachineModelDefaults | null {
  if (!record(v) || Object.keys(v).some((key) => key !== 'model' && key !== 'thinkingLevel'))
    return null
  let model: MachineModelDefaults['model'] | null = null
  if (v.model !== undefined) {
    if (!record(v.model) || Object.keys(v.model).some((key) => key !== 'provider' && key !== 'id'))
      return null
    model = modelChoice(v.model.provider, v.model.id)
    if (!model) return null
  }
  const level = thinkingLevel(v.thinkingLevel)
  if (v.thinkingLevel !== undefined && !level) return null
  return { ...(model ? { model } : {}), ...(level ? { thinkingLevel: level } : {}) }
}
