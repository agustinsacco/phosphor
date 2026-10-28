import { createContext, useContext } from 'react'

/** UI capabilities only. Host authorization remains in the adapter and Host. */
export interface Platform {
  formFactor: 'expanded' | 'compact'
  /** Pane arrangement is independent of viewport size and native access. */
  splitPanes: boolean
  localLanes: boolean
  fileEditing: boolean
  terminal: boolean
  scriptedArtifacts: boolean
  nativeFiles: boolean
  machineSettings: boolean
  /** Spellcheck, autocomplete and prompt learning in text fields (Settings → Writing). */
  writingAssist: boolean
  /** The app-wide keyboard shortcuts Settings → Keybindings lists are installed. */
  appShortcuts: boolean
  /** UI scale is applied as native page zoom. */
  pageZoom: boolean
  /** Font preferences persist across restarts, not only for the page's life. */
  savedFontPrefs: boolean
  /** About can read the app, pi and runtime versions and run native update checks. */
  appInfo: boolean
  /** Send feedback files an issue through the native feedback service. */
  feedback: boolean
  /** The client can be installed as an app from this page (Settings → App installation). */
  installableApp: boolean
}
export const DESKTOP_PLATFORM: Platform = Object.freeze({
  formFactor: 'expanded',
  splitPanes: true,
  localLanes: true,
  fileEditing: true,
  terminal: true,
  scriptedArtifacts: true,
  nativeFiles: true,
  machineSettings: true,
  writingAssist: true,
  appShortcuts: true,
  pageZoom: true,
  savedFontPrefs: true,
  appInfo: true,
  feedback: true,
  installableApp: false,
})
export const COMPACT_PLATFORM: Platform = Object.freeze({
  formFactor: 'compact',
  splitPanes: false,
  localLanes: false,
  fileEditing: false,
  // Host shells over the Host connection; a browser never opens a local one.
  terminal: true,
  scriptedArtifacts: false,
  nativeFiles: false,
  // Host settings over the Host connection, after the explicit configuration access request.
  machineSettings: true,
  writingAssist: false,
  appShortcuts: false,
  pageZoom: false,
  savedFontPrefs: false,
  appInfo: false,
  feedback: false,
  installableApp: true,
})
/** A wide browser changes presentation, never its authority or native capabilities. */
export const WIDE_BROWSER_PLATFORM: Platform = Object.freeze({
  ...COMPACT_PLATFORM,
  formFactor: 'expanded',
})
const PlatformContext = createContext(DESKTOP_PLATFORM)
export const PlatformProvider = PlatformContext.Provider
export const usePlatform = (): Platform => useContext(PlatformContext)
