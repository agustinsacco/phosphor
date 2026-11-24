import { useState } from 'react'
import { ipcErrorText } from '@shared/errors'
import { useSessionsStore } from '@/stores/sessions'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { promptText } from '@/stores/prompt'
import { useNavigation } from '@/navigation/Navigation'
import type { DisplayNode } from '@/features/sessions/treeLayout'
import { editHostEntry, copyHostLane, type HostEditLane } from './hostLaneEditing'

export function editingError(error: unknown) {
  useExtensionUiStore.getState().pushToast(ipcErrorText(error), 'error')
}
async function withSessionClosed(path: string, workspacePath: string, action: () => Promise<void>) {
  const store = useSessionsStore.getState()
  const live = Object.values(store.live).find((l) => l.diskPath === path)
  if (live) await store.disposeSession(live.phosphorId)
  await action()
  await store.refreshDisk(workspacePath)
}
async function openListed(workspacePath: string, path: string) {
  const metas = await window.phosphor.invoke('sessions:list', workspacePath)
  const next = metas.find((m) => m.path === path)
  if (next) await useSessionsStore.getState().openDiskSession(workspacePath, next)
}
export function useTreeActions(
  path: string,
  workspacePath: string,
  hostLane: HostEditLane | undefined,
  onClose: () => void,
  labeled: () => void,
) {
  const { navigate } = useNavigation()
  const [busy, setBusy] = useState<string | null>(null)
  const perform = async (status: string, action: () => Promise<void>): Promise<void> => {
    setBusy(status)
    try {
      await action()
    } catch (error) {
      editingError(error)
    } finally {
      setBusy(null)
    }
  }
  const jumpHere = (node: DisplayNode) =>
    perform('Jumping…', async () => {
      if (hostLane) {
        await editHostEntry(hostLane, 'jump', node.id)
        navigate({ to: 'lane', lane: hostLane })
      } else {
        await withSessionClosed(path, workspacePath, async () => {
          await window.phosphor.invoke('sessions:jump', path, node.id)
        })
        await openListed(workspacePath, path)
      }
      onClose()
    })
  const forkHere = (node: DisplayNode) =>
    perform('Forking…', async () => {
      if (hostLane) navigate({ to: 'lane', lane: await copyHostLane(hostLane, 'fork', node.id) })
      else {
        const newPath = await window.phosphor.invoke('sessions:forkAt', path, node.id)
        await useSessionsStore.getState().refreshDisk(workspacePath)
        await openListed(workspacePath, newPath)
      }
      onClose()
    })

  const labelNode = async (node: DisplayNode): Promise<void> => {
    const label = await promptText({
      title: 'Label this point',
      message: 'Empty to clear the label',
      initialValue: node.label ?? '',
      allowEmpty: true,
    })
    if (label === undefined) return
    await perform('Labeling…', async () => {
      if (hostLane) await editHostEntry(hostLane, 'label', node.id, label)
      else
        await withSessionClosed(path, workspacePath, async () => {
          await window.phosphor.invoke('sessions:appendLabel', path, node.id, label || undefined)
        })
      labeled()
    })
  }

  return { busy, jumpHere, forkHere, labelNode }
}
