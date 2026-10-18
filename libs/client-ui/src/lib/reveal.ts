import { hostPlatform } from './shortcuts'

/**
 * What the OS calls its file manager. "Reveal in file manager" is correct
 * everywhere and natural nowhere; every platform has a name for this and
 * users look for that name.
 */
export function revealLabel(): string {
  const platform = hostPlatform()
  if (platform === 'darwin') return 'Reveal in Finder'
  if (platform === 'win32') return 'Show in Explorer'
  return 'Reveal in file manager'
}
