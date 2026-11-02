import type { SettingsNoticeProps } from '@/components/form'
import type { PiResources } from '@shared/models'
import type { SectionStatus } from '../sectionStatus'

/** The pi a machine runs: found and new enough, or why not. */
export interface PiFacts {
  ok: boolean
  version?: string
  /** Where pi is installed. */
  location: string
  /** The oldest pi Phosphor supports; This Mac reports it. */
  minVersion?: string
  /** Why pi is unusable, when it is. */
  problem?: string
}

/** A Host's own runtime and its signed self-update. */
export interface HostRuntime {
  version: string
  platform: string
  configPath: string
  /** One line about the update; says when the Host cannot run it. */
  updateNote: string
  canUpdate: boolean
  update: () => void
}

/** One machine's Advanced blocks. A block renders only when its data is present. */
export interface AdvancedSource {
  status: SectionStatus
  /** "Update this Host" and the like. */
  notice: SettingsNoticeProps | null
  caps: {
    /** Raw JSON editors for pi's own settings and models files. */
    rawFiles: boolean
    /** The worktree reclamation sweep. */
    maintenance: boolean
  }
  /** null while it is being checked; absent where the machine does not report it. */
  pi?: PiFacts | null
  agentDir?: string
  /** The PATH pi runs with. */
  path?: readonly string[]
  host?: HostRuntime
  /** Allowlisted environment variable names, never values. */
  environment?: readonly { name: string; available: boolean; passed: boolean }[]
  /** pi's loose resources; null while loading. */
  resources?: PiResources | null
  editFile?: (name: 'settings' | 'models') => void
  /** The raw editor while it is open. */
  dialog?: React.ReactNode
  /** What Advanced never shows. */
  footnote: string
}
