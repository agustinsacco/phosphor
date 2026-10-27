import { HOST_TOO_OLD } from '@shared/host-protocol-repositories'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useExtensionUiStore } from '@/stores/extensionUi'

export type MoveDirection = 'up' | 'down'

/** The Host's repository ids with `id` swapped one place, or null at an end or for a stranger. */
export function movedRepositoryOrder(
  ids: readonly string[],
  id: string,
  direction: MoveDirection,
): string[] | null {
  const from = ids.indexOf(id)
  const to = from + (direction === 'up' ? -1 : 1)
  if (from < 0 || to < 0 || to >= ids.length) return null
  const next = [...ids]
  ;[next[from], next[to]] = [next[to]!, next[from]!]
  return next
}

/**
 * Move one folder on its Host. The order lives in the Host's config, so every client that
 * shows this Host sees the new order once the Host republishes its repositories.
 */
export async function moveRemoteRepository(
  hostId: string,
  repositoryId: string,
  direction: MoveDirection,
): Promise<void> {
  const host = useRemoteLanesStore.getState().hosts[hostId]
  const next =
    host &&
    movedRepositoryOrder(
      host.repositories.map((r) => r.id),
      repositoryId,
      direction,
    )
  if (!next) return
  try {
    await window.phosphor.invoke('hosts:orderRepositories', hostId, next)
  } catch (error) {
    // A toast, not the sidebar's sticky error: nothing else would clear it.
    useExtensionUiStore
      .getState()
      .pushToast(
        error instanceof Error && error.message.includes(HOST_TOO_OLD)
          ? `Moving folders needs a newer Host. ${HOST_TOO_OLD}`
          : 'The Host could not move this folder. Try again.',
        'error',
      )
  }
}
