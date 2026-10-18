import type { FontPrefs } from '@shared/models'
import inter from '@/assets/fonts/InterVariable.woff2?url'
import interItalic from '@/assets/fonts/InterVariable-Italic.woff2?url'
import mono from '@/assets/fonts/JetBrainsMono.ttf?url'
import monoItalic from '@/assets/fonts/JetBrainsMono-Italic.ttf?url'

/** One preference mapping for both the editable and read-only Monaco surfaces. */
export function editorFontOptions(fonts: Pick<FontPrefs, 'editorFontSize' | 'monoFont'>) {
  return {
    fontSize: fonts.editorFontSize,
    fontFamily: `${fonts.monoFont}, ui-monospace, SF Mono, Menlo, monospace`,
  }
}

/** Register only settled faces BEFORE React mounts Monaco/xterm and caches metrics.
 * Slow/broken assets fall back for this launch, never swap underneath a cursor.
 * These are local Vite assets; the deadline bounds startup, not a network service.
 */
export async function loadBundledFonts(): Promise<void> {
  if (typeof FontFace === 'undefined' || !document.fonts) return
  const faces = [
    new FontFace('Inter', `url("${inter}")`, { weight: '100 900' }),
    new FontFace('Inter', `url("${interItalic}")`, { weight: '100 900', style: 'italic' }),
    new FontFace('JetBrains Mono', `url("${mono}")`, { weight: '100 800' }),
    new FontFace('JetBrains Mono', `url("${monoItalic}")`, { weight: '100 800', style: 'italic' }),
  ]
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.allSettled(faces.map((face) => face.load())),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1500)
      }),
    ])
    for (const face of faces) {
      if (face.status === 'loaded') document.fonts.add(face)
      else console.warn(`Bundled font unavailable: ${face.family} ${face.style}; using fallback`)
    }
  } finally {
    clearTimeout(timer)
  }
}
