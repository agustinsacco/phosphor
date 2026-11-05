import { openMachinePage } from '@/stores/machinePages'
import { useSkillsStore } from '@/stores/skills'
import { useSettingsUiStore } from '../../settingsUiStore'

/**
 * The Skills page for `machine` ('local' or a Host id), where a package's
 * skills group under it: Settings closes and the page is pinned to that
 * machine, whichever one it showed last.
 */
export function openSkillsOn(machine: string): void {
  useSettingsUiStore.getState().setOpen(false)
  useSkillsStore.getState().setTab('yours')
  openMachinePage('skills', machine)
}
