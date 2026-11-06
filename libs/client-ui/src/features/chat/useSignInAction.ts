import { localMachineLabel } from '@/lib/localMachine'
import { machineLabel } from '@/stores/remoteLanes'
import { useOpenSettings } from '@/features/settings/useOpenSettings'
import type { SettingsMachine } from '@/features/settings/settingsUiStore'
import { signInLabel } from './errorRemedies'

/**
 * Sign in on a machine: Settings → Accounts for it. One action for the chat's
 * sign-in remedy and every machine's start model picker.
 */
export function useSignInAction(machine: SettingsMachine): { label: string; run: () => void } {
  const openSettings = useOpenSettings()
  return {
    label: signInLabel(machine === 'local' ? localMachineLabel() : machineLabel(machine)),
    run: () => openSettings(machine, 'accounts'),
  }
}
