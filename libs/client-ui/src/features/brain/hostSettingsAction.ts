/** The editor keeps its draft unless the selected Host acknowledges the change. */
export async function runHostSettingsAction(
  operation: () => Promise<unknown>,
  refresh: () => Promise<void>,
  onError: () => void,
): Promise<boolean> {
  try {
    await operation()
    await refresh()
    return true
  } catch {
    onError()
    return false
  }
}
