import { memo, useEffect, useRef } from 'react'
import type * as MonacoTypes from 'monaco-editor'
import { getMonaco, monacoThemeFor } from '@/lib/monaco'
import { useSettingsStore } from '@/stores/settings'
import { editorFontOptions } from '@/lib/fonts'

type Monaco = typeof MonacoTypes
type Editor = MonacoTypes.editor.IStandaloneCodeEditor

const viewStates = new Map<string, MonacoTypes.editor.ICodeEditorViewState | null>()

/**
 * Release the Monaco model and saved view state for a path.
 *
 * Monaco keeps every `createModel` in a GLOBAL registry until it is disposed —
 * `attachModel` relies on that to preserve undo stacks across tab switches
 * (`monaco.editor.getModel(uri)` finds the old one). The cost is that closing a
 * tab freed nothing: each model retains the full text buffer plus tokenization
 * state, and for TS/JS/JSON/CSS/HTML it is mirrored into a language web worker,
 * so the bytes were held twice. Browsing N files retained all N forever.
 *
 * Called by the files store, which owns the "is this file still open" question.
 */
export function releaseFileModel(path: string): void {
  viewStates.delete(path)
  // Lazy: if Monaco was never loaded there is nothing to release, and we must
  // not pull the (large) editor bundle in just to clean up.
  void import('@/lib/monaco').then(({ peekMonaco }) => {
    const monaco = peekMonaco()
    if (!monaco) return
    monaco.editor.getModel(monaco.Uri.file(path))?.dispose()
  })
}

interface MonacoEditorProps {
  path: string
  language: string
  value: string
  readOnly?: boolean
  revealLine?: number
  onChange?: (value: string) => void
  onSave?: () => void
}

/** Single Monaco editor with per-path models (undo stacks survive tab switches). */
export const MonacoEditor = memo(function MonacoEditor({
  path,
  language,
  value,
  readOnly = false,
  revealLine,
  onChange,
  onSave,
}: MonacoEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const currentPathRef = useRef<string>(path)
  const suppressChange = useRef(false)
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme)
  const fonts = useSettingsStore((s) => s.fonts)

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  // Mount once.
  useEffect(() => {
    let disposed = false
    let editor: Editor | null = null

    void getMonaco().then((monaco) => {
      if (disposed || !containerRef.current) return
      monacoRef.current = monaco
      const fonts = useSettingsStore.getState().fonts
      editor = monaco.editor.create(containerRef.current, {
        theme: monacoThemeFor(useSettingsStore.getState().resolvedTheme),
        automaticLayout: true,
        ...editorFontOptions(fonts),
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        padding: { top: 8 },
        renderWhitespace: 'selection',
        smoothScrolling: true,
        readOnly,
      })
      editorRef.current = editor

      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        onSaveRef.current?.()
      })

      editor.onDidChangeModelContent(() => {
        if (suppressChange.current) return
        onChangeRef.current?.(editor!.getValue())
      })

      attachModel(monaco, editor, path, language, value, revealLine)
    })

    return () => {
      disposed = true
      if (editor) {
        viewStates.set(currentPathRef.current, editor.saveViewState())
        editor.dispose()
      }
      editorRef.current = null
    }
  }, [])

  // Path switch: swap model.
  useEffect(() => {
    const monaco = monacoRef.current
    const editor = editorRef.current
    if (!monaco || !editor) return
    if (currentPathRef.current !== path) {
      viewStates.set(currentPathRef.current, editor.saveViewState())
      attachModel(monaco, editor, path, language, value, revealLine)
      currentPathRef.current = path
    }
  })

  // External value change (reload from disk) for the current model.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel()
    if (model && model.getValue() !== value && currentPathRef.current === path) {
      suppressChange.current = true
      // Preserve cursor where possible.
      const position = editor.getPosition()
      model.setValue(value)
      if (position) editor.setPosition(position)
      suppressChange.current = false
    }
  }, [value, path])

  // Reveal line requests.
  useEffect(() => {
    const editor = editorRef.current
    if (editor && revealLine !== undefined) {
      editor.revealLineInCenter(revealLine)
      editor.setPosition({ lineNumber: revealLine, column: 1 })
      editor.focus()
    }
  }, [revealLine, path])

  // Theme switching.
  useEffect(() => {
    monacoRef.current?.editor.setTheme(monacoThemeFor(resolvedTheme))
  }, [resolvedTheme])

  // Live font updates from settings.
  useEffect(() => {
    editorRef.current?.updateOptions(editorFontOptions(fonts))
  }, [fonts])

  function attachModel(
    monaco: Monaco,
    editor: Editor,
    modelPath: string,
    modelLanguage: string,
    modelValue: string,
    reveal?: number,
  ): void {
    const uri = monaco.Uri.file(modelPath)
    let model = monaco.editor.getModel(uri)
    if (!model) {
      model = monaco.editor.createModel(modelValue, modelLanguage, uri)
    } else if (model.getValue() !== modelValue) {
      suppressChange.current = true
      model.setValue(modelValue)
      suppressChange.current = false
    }
    editor.setModel(model)
    const saved = viewStates.get(modelPath)
    if (saved) editor.restoreViewState(saved)
    if (reveal !== undefined) {
      editor.revealLineInCenter(reveal)
      editor.setPosition({ lineNumber: reveal, column: 1 })
    }
    // A normal explorer click keeps keyboard focus in the tree for copy/cut.
    // Explicit line navigation still focuses the editor.
    if (reveal !== undefined) editor.focus()
  }

  return <div ref={containerRef} className="h-full w-full" />
})

interface MonacoDiffProps {
  originalText: string
  modifiedText: string
  language: string
  renderSideBySide: boolean
}

export const MonacoDiff = memo(function MonacoDiff({
  originalText,
  modifiedText,
  language,
  renderSideBySide,
}: MonacoDiffProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<MonacoTypes.editor.IStandaloneDiffEditor | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme)
  const fonts = useSettingsStore((s) => s.fonts)

  useEffect(() => {
    let disposed = false
    let editor: MonacoTypes.editor.IStandaloneDiffEditor | null = null
    let original: MonacoTypes.editor.ITextModel | null = null
    let modified: MonacoTypes.editor.ITextModel | null = null

    void getMonaco().then((monaco) => {
      if (disposed || !containerRef.current) return
      monacoRef.current = monaco
      editor = monaco.editor.createDiffEditor(containerRef.current, {
        theme: monacoThemeFor(useSettingsStore.getState().resolvedTheme),
        automaticLayout: true,
        ...editorFontOptions(useSettingsStore.getState().fonts),
        minimap: { enabled: false },
        readOnly: true,
        renderSideBySide,
        scrollBeyondLastLine: false,
        hideUnchangedRegions: { enabled: true },
        renderOverviewRuler: false,
      })
      original = monaco.editor.createModel(originalText, language)
      modified = monaco.editor.createModel(modifiedText, language)
      editor.setModel({ original, modified })
      editorRef.current = editor
    })

    return () => {
      disposed = true
      editor?.dispose()
      original?.dispose()
      modified?.dispose()
    }
  }, [originalText, modifiedText, language])

  useEffect(() => {
    editorRef.current?.updateOptions(editorFontOptions(fonts))
  }, [fonts])

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide })
  }, [renderSideBySide])

  useEffect(() => {
    monacoRef.current?.editor.setTheme(monacoThemeFor(resolvedTheme))
  }, [resolvedTheme])

  return <div ref={containerRef} className="h-full w-full" />
})
