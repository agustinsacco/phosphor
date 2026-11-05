/**
 * Monaco singleton: bundled workers (no CDN — strict CSP), theme definitions
 * bound to Phosphor tokens, lazy loading as an async chunk.
 */
import type * as MonacoTypes from 'monaco-editor'
import { setLoadedMonaco } from './monacoInstance'

export { peekMonaco } from './monacoInstance'

let monacoPromise: Promise<typeof MonacoTypes> | null = null

export function getMonaco(): Promise<typeof MonacoTypes> {
  if (!monacoPromise) {
    monacoPromise = loadMonaco().then((monaco) => {
      setLoadedMonaco(monaco)
      return monaco
    })
  }
  return monacoPromise
}

async function loadMonaco(): Promise<typeof MonacoTypes> {
  const [
    monaco,
    { default: EditorWorker },
    { default: JsonWorker },
    { default: CssWorker },
    { default: HtmlWorker },
    { default: TsWorker },
  ] = await Promise.all([
    import('monaco-editor'),
    import('monaco-editor/esm/vs/editor/editor.worker?worker'),
    import('monaco-editor/esm/vs/language/json/json.worker?worker'),
    import('monaco-editor/esm/vs/language/css/css.worker?worker'),
    import('monaco-editor/esm/vs/language/html/html.worker?worker'),
    import('monaco-editor/esm/vs/language/typescript/ts.worker?worker'),
  ])

  ;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      switch (label) {
        case 'json':
          return new JsonWorker()
        case 'css':
        case 'scss':
        case 'less':
          return new CssWorker()
        case 'html':
        case 'handlebars':
        case 'razor':
          return new HtmlWorker()
        case 'typescript':
        case 'javascript':
          return new TsWorker()
        default:
          return new EditorWorker()
      }
    },
  }

  // Phosphor editor themes (docs/style-guide.md). Hex literals on purpose —
  // Monaco takes a JS object; keep in sync with --px-* in src/styles/index.css.
  monaco.editor.defineTheme('phosphor-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#26262a',
      'editorLineNumber.foreground': '#96969e',
      'editorLineNumber.activeForeground': '#66666e',
      'editor.selectionBackground': '#f6e9d4',
      'editor.lineHighlightBackground': '#f7f7f8',
      'editorCursor.foreground': '#b35c0f',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#e4e4e7',
      'diffEditor.insertedTextBackground': '#4c8a5426',
      'diffEditor.removedTextBackground': '#bb4a3c21',
      'diffEditor.insertedLineBackground': '#4c8a5414',
      'diffEditor.removedLineBackground': '#bb4a3c10',
    },
  })

  monaco.editor.defineTheme('phosphor-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      // Editor sits on --px-surface (it lives inside the files-pane card);
      // the terminal is the one dark surface that sits on --px-bg instead.
      'editor.background': '#2a2721',
      'editor.foreground': '#ece7db',
      'editorLineNumber.foreground': '#7c766a',
      'editorLineNumber.activeForeground': '#aca496',
      'editor.selectionBackground': '#3d3220',
      'editor.lineHighlightBackground': '#322e27',
      'editorCursor.foreground': '#eca03d',
      'editorWidget.background': '#322e27',
      'editorWidget.border': '#3a352c',
      'diffEditor.insertedTextBackground': '#7fbe8830',
      'diffEditor.removedTextBackground': '#dd766328',
      'diffEditor.insertedLineBackground': '#7fbe881a',
      'diffEditor.removedLineBackground': '#dd766315',
    },
  })

  // Keep TS service quiet on random project files (no tsconfig context).
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  })
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  })

  return monaco
}

export function monacoThemeFor(resolved: 'light' | 'dark'): string {
  return resolved === 'dark' ? 'phosphor-dark' : 'phosphor-light'
}

export { languageForPath } from './languages'
