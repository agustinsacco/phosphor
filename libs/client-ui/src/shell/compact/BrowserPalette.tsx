import { useEffect } from 'react'
import { CommandPalette } from '@/features/palette/CommandPalette'
import { usePlatform } from '@/platform/Platform'
import { useNavigation } from '@/navigation/Navigation'
import { openTranscriptFindForFocus } from '@/components/search/findTargets'
import { ignoreShortcut, shortcutOverlayOpen } from '@/lib/shortcutContext'

/** Browser accelerators stay native outside the transcript and on phones. */
export function BrowserPalette(): React.JSX.Element {
  const wide = usePlatform().formFactor === 'expanded'
  const { location } = useNavigation()
  useEffect(() => {
    if (!wide) return
    const onKey = (event: KeyboardEvent): void => {
      if (ignoreShortcut(event) || !event.cancelable || shortcutOverlayOpen()) return
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        event.code === 'KeyF' &&
        openTranscriptFindForFocus()
      )
        event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wide])
  // A route change must not leave a query or folder picker from a previous screen behind.
  return <CommandPalette key={JSON.stringify(location)} workspacePath="" keyboardShortcut={wide} />
}
