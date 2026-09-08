import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { piCall, piCallOk } from '@/lib/rpc'
import { presentText, promptText } from '@/stores/prompt'
import { formatSessionDebugInfo } from '@/lib/sessionDebugInfo'

/**
 * Session operations shared by the chat composer, the session menu and the
 * sidebar's context menu.
 *
 * Each of these used to exist as three near-identical copies that had drifted
 * apart in their error handling — the sidebar and session-menu variants
 * discarded RPC failures, so a failed export or rename looked like nothing had
 * happened. Routing all three through one implementation makes the reporting
 * consistent.
 */

/**
 * Export a session to HTML via the native save dialog, then reveal the file.
 * No-op when the user cancels the dialog.
 */
export async function exportSessionHtml(sessionId: string, defaultName = 'session'): Promise<void> {
  const outputPath = await window.phosphor.invoke('app:saveDialog', {
    title: 'Export session as HTML',
    defaultPath: `${defaultName}.html`,
    filters: [{ name: 'HTML', extensions: ['html'] }],
  })
  if (!outputPath) return

  const data = await piCall(sessionId, { type: 'export_html', outputPath })
  if (data) await window.phosphor.invoke('app:revealPath', data.path)
}

/**
 * Apply a new session name without prompting. Returns true on success.
 *
 * Callers that collect the name themselves (e.g. an inline sidebar input)
 * pass it straight through here and skip the modal.
 */
export async function applySessionRename(sessionId: string, name: string): Promise<boolean> {
  const trimmed = name.trim()
  if (!trimmed) return false
  if (!(await piCallOk(sessionId, { type: 'set_session_name', name: trimmed }))) return false
  useChatStore.getState().patchMeta(sessionId, { sessionName: trimmed })
  return true
}

/**
 * Prompt for a new session name and apply it. Returns the new name on success
 * so callers can run their own follow-up (e.g. refreshing the disk listing),
 * or `undefined` when cancelled or failed.
 */
export async function renameSession(
  sessionId: string,
  currentName?: string,
): Promise<string | undefined> {
  const name = await promptText({
    title: 'Rename session',
    placeholder: 'Session name',
    initialValue: currentName ?? '',
  })
  if (!name) return undefined

  if (!(await applySessionRename(sessionId, name))) return undefined
  return name
}

/**
 * Copy a pointer to everything this session wrote to disk, for pasting into a
 * bug report or a debugging conversation.
 *
 * Provider and model come from the live session when there is one; a session
 * that is only on disk still yields its pi paths, which is the part that
 * always exists. See lib/sessionDebugInfo for why the Claude Code path is
 * worth carrying separately.
 */
export async function copySessionDebugInfo(
  meta: { path: string; sessionId: string; cwd: string },
  livePhosphorId?: string,
): Promise<void> {
  const chat = livePhosphorId ? useChatStore.getState().sessions[livePhosphorId]?.meta : undefined
  // The CLI's transcript is filed under the CLI's own session id, which only
  // the provider's sidecar map knows. Best-effort: a failed lookup falls back
  // to the pi id inside formatSessionDebugInfo.
  const claudeSessionId = await window.phosphor
    .invoke('sessions:claudeSessionId', meta.sessionId)
    .catch(() => null)
  const text = formatSessionDebugInfo({
    path: meta.path,
    sessionId: meta.sessionId,
    cwd: meta.cwd,
    provider: chat?.model?.provider,
    model: chat?.model?.id,
    claudeSessionId,
  })
  const toast = useExtensionUiStore.getState().pushToast
  try {
    await navigator.clipboard.writeText(text)
    toast('Session debug info copied', 'info')
  } catch {
    // Clipboard can be denied; the text is useless if it is neither copied nor
    // shown, so fall back to something the user can select by hand.
    await presentText({ title: 'Copy session debug info', text })
  }
}
