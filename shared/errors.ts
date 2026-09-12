/**
 * Turning an unknown thrown value into a message.
 *
 * Lives in `shared/` because both sides need it: the main process reports
 * subprocess and git failures, the renderer reports them again after they
 * cross IPC. Two copies would drift.
 */

/**
 * Message for an unknown thrown value.
 *
 * Deliberately NOT `(error as Error).message` — that cast is a lie whenever the
 * rejection is a string, a DOMException-like, or an IPC-serialized plain
 * object, and it throws a second, more confusing error while handling the
 * first. `catch` binds `unknown`; this is the one place that narrows it.
 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  // IPC and subprocess rejections often arrive as plain objects that carry a
  // message without being real Errors.
  if (error && typeof error === 'object' && 'message' in error) {
    const { message } = error as { message: unknown }
    if (typeof message === 'string') return message
  }
  return String(error)
}

/**
 * Message for an IPC rejection, without Electron's wrapper.
 *
 * A handler that throws reaches the renderer as
 * `Error invoking remote method 'x': Error: …`, and every character before the
 * real complaint is noise in a toast or a pane.
 */
export function ipcErrorText(error: unknown): string {
  return errorText(error).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
}
