import type { SaveState, SettingsNoticeProps } from '@/components/form'
import type { AgentFieldKey } from '@shared/machine-agent-behavior'
import type { MachineContext } from '@shared/machine-prompt'
import type { AgentDirectivePrefs } from '@shared/models'
import type { InstructionsSource } from '../../instructions/instructionsSource'

/** A section's read: still loading, ready, or failed with a way to try again. */
export type SectionStatus = 'loading' | 'ready' | { error: string; retry(): void }

/** pi settings.json contents, as one scope's file holds them: never merged. */
export type AgentValues = Record<string, unknown>

/** A model to pick: `value` is the `[provider, id]` pair as JSON. */
export interface AgentModelChoice {
  value: string
  label: string
}

export interface AgentCaps {
  /** A set value can be cleared back to what it inherits (a Host whose read says so). */
  clear: boolean
  /** A folder keeps its own directive switches (This Mac only). */
  folderDirectives: boolean
}

/** Phosphor's own policy for every lane on the machine, edited at machine scope only. */
export interface AgentPolicy {
  budget: string
  setBudget(value: string): void
  autoName: boolean
  setAutoName(on: boolean): void
  /** Said under the automatic naming switch: when a change takes effect, if not at once. */
  autoNameNote?: string
}

export interface AgentDirectives {
  value: AgentDirectivePrefs
  set(next: AgentDirectivePrefs): void
  /** Folder scope with folder directives: the folder's override, and how to drop it. */
  override?: { active: boolean; clear(): void }
  /** A save is waiting on the machine. */
  disabled?: boolean
  /** Whose lanes the preview describes. */
  machine: MachineContext
  /** Retired free text only This Mac's migration left behind. */
  retired?: { entries: Record<string, string>; dismissed(): void }
}

/**
 * What the Agent view needs from one machine: This Mac (`useLocalAgent`) or a
 * Host (`useHostAgent`). The view reads nothing else.
 */
export interface AgentSource {
  status: SectionStatus
  notice?: SettingsNoticeProps | null
  caps: AgentCaps
  save?: SaveState
  /** Folder scope: values left unset inherit the machine's. */
  folder: boolean
  /** Editing is off: a malformed file, a stale draft, a read in flight. */
  blocked: boolean
  /** The pi settings this machine can edit; a field it cannot is not shown. */
  fields: readonly AgentFieldKey[]
  own: AgentValues
  /** The machine scope's values, in folder scope; null when unknown or at machine scope. */
  inherited: AgentValues | null
  /** `undefined` clears the field, so it inherits again. */
  setField(key: AgentFieldKey, value: unknown): void
  /** `[provider, id]` as JSON, or '' for none; this scope's own. */
  model: string
  inheritedModel: string
  /** '' clears it. */
  setModel(value: string): void
  /** null while loading. */
  models: readonly AgentModelChoice[] | null
  /** Set when the catalogue could not be read. */
  catalogue?: { failed: true; retry(): void }
  /** Machine-wide policy; null in folder scope. */
  policy: AgentPolicy | null
  /** null where this scope keeps none. */
  directives: AgentDirectives | null
  instructions: InstructionsSource | null
}
