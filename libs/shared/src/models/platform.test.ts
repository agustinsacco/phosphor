import { expectTypeOf, it } from 'vitest'
import type {
  AgentSettingsHealth,
  ConfigFileHealth,
  SaveDialogOptions,
  UpdatePhase,
  UpdateState,
} from './platform'

it('platform keeps config health, update and save-dialog contracts', () => {
  expectTypeOf<ConfigFileHealth>().toEqualTypeOf<{
    exists: boolean
    malformed: boolean
    error?: string
  }>()
  expectTypeOf<AgentSettingsHealth>().toEqualTypeOf<{
    global: ConfigFileHealth
    project: ConfigFileHealth | null
  }>()
  expectTypeOf<SaveDialogOptions>().toEqualTypeOf<{
    title?: string
    defaultPath?: string
    filters?: { name: string; extensions: string[] }[]
  }>()
  expectTypeOf<UpdatePhase>().toEqualTypeOf<
    | 'idle'
    | 'checking'
    | 'downloading'
    | 'installing'
    | 'downloaded'
    | 'manual-download'
    | 'unsupported'
  >()
  expectTypeOf<UpdateState>().toEqualTypeOf<{
    phase: UpdatePhase
    version?: string
    progressPercent?: number
    releaseUrl?: string
  }>()
})
