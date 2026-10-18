/**
 * The Monaco instance once `monaco.ts` has loaded it, kept apart from the
 * loader: this module names `monaco-editor` only as a type, so code outside
 * the editor (find reading the editor's selection) can ask about editors
 * without depending on the editor bundle.
 */
import type * as MonacoTypes from 'monaco-editor'

let loaded: typeof MonacoTypes | null = null

/** Called by the loader when the bundle arrives. */
export function setLoadedMonaco(monaco: typeof MonacoTypes): void {
  loaded = monaco
}

/**
 * The Monaco instance if it is ALREADY loaded, else null.
 *
 * For cleanup paths (disposing a model when a tab closes) that must not pull
 * the multi-megabyte editor chunk in just to discover there is nothing to free.
 */
export function peekMonaco(): typeof MonacoTypes | null {
  return loaded
}

/**
 * The text selected in the editor that has focus, if one does. The page
 * selection cannot see it: Monaco draws its selection itself.
 */
export function focusedEditorSelection(): string | null {
  const editor = loaded?.editor.getEditors().find((candidate) => candidate.hasTextFocus())
  const selection = editor?.getSelection()
  const model = editor?.getModel()
  return selection && model ? model.getValueInRange(selection) : null
}
