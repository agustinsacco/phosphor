/**
 * Shiki singleton with dual light/dark themes driven by CSS variables, so
 * theme switching is instant (no re-highlight).
 */
import type { Highlighter } from 'shiki'

let highlighterPromise: Promise<Highlighter> | null = null
const loadedLanguages = new Set<string>()

const CORE_LANGUAGES = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'json',
  'bash',
  'python',
  'html',
  'css',
  'markdown',
  'yaml',
  'diff',
]

const SHIKI_THEMES = { light: 'vitesse-light', dark: 'vitesse-dark' } as const

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(async (shiki) => {
      const highlighter = await shiki.createHighlighter({
        themes: [SHIKI_THEMES.light, SHIKI_THEMES.dark],
        langs: CORE_LANGUAGES,
      })
      for (const lang of CORE_LANGUAGES) loadedLanguages.add(lang)
      return highlighter
    })
  }
  return highlighterPromise
}

/** Highlight to HTML; falls back to escaped plaintext for unknown languages. */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const highlighter = await getHighlighter()
  let resolved = lang.toLowerCase()

  if (!loadedLanguages.has(resolved)) {
    try {
      await highlighter.loadLanguage(resolved as Parameters<Highlighter['loadLanguage']>[0])
      loadedLanguages.add(resolved)
    } catch {
      resolved = 'text'
    }
  }

  return highlighter.codeToHtml(code, {
    lang: resolved,
    themes: SHIKI_THEMES,
    defaultColor: false,
  })
}
