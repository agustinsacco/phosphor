import { useState } from 'react'
import { ipcErrorText } from '@shared/errors'
import { AGENT_DIRECTIVE_KEYS, type AgentDirectivePrefs } from '@shared/models/directives'
import type { MachineContext } from '@shared/machine-prompt'
import { runAgentOp } from '@/features/agent-control/agentOps'
import { useExtensionUiStore } from '@/stores/extensionUi'
import type { HostSettingsState } from '../../machine/useHostSettings'

export function useFolderDirectiveEditor(
  hostId: string,
  project: string | undefined,
  settings: HostSettingsState,
) {
  const [saving, setSaving] = useState(false)
  return (value: AgentDirectivePrefs, machine: MachineContext) => ({
    value,
    machine,
    disabled: saving || settings.loading || settings.saving,
    set(next: AgentDirectivePrefs) {
      const key = AGENT_DIRECTIVE_KEYS.find((k) => next[k] !== value[k])
      if (!key || !project || saving) return
      setSaving(true)
      void runAgentOp(hostId, 'directives.set', { project, key, on: next[key] })
        .then(async (result) => {
          useExtensionUiStore.getState().pushToast(result.text, 'info')
          await settings.refresh()
        })
        .catch((error: unknown) =>
          useExtensionUiStore.getState().pushToast(ipcErrorText(error), 'error'),
        )
        .finally(() => setSaving(false))
    },
  })
}
