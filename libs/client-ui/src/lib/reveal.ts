import { hostPlatform } from './shortcuts'

/**
 * What the OS calls its file manager. "Reveal in file manager" is correct
 * everywhere and natural nowhere; every platform has a name for this and
 * users look for that name.
 */
export function revealLabel(): string {
  const platform = hostPlatform()
  if (platform === 'darwin') return 'Reveal in Finder'
  return 'Reveal in file manager'
}
