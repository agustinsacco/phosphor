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

/** A machine's update action: one line about it, and the button that runs it. */
export interface MachineUpdate {
  /** Says when the machine cannot run it. */
  note: string
  action: string
  primary?: boolean
  disabled: boolean
  run: () => void
}

/** What runs the machine (Phosphor on This Mac, the Host service), and its update. */
export interface MachineRuntime {
  /** Names the rows: "Phosphor version", "Host version". */
  product: 'Phosphor' | 'Host'
  version: string
  /** `process.platform` (darwin, linux, win32), when known. */
  platform?: string
  /** A Host's config file; This Mac's settings have no single one. */
  configPath?: string
  update: MachineUpdate
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
  runtime?: MachineRuntime
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
