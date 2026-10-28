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
})
/** A wide browser changes presentation, never its authority or native capabilities. */
export const WIDE_BROWSER_PLATFORM: Platform = Object.freeze({
  ...COMPACT_PLATFORM,
  formFactor: 'expanded',
})
const PlatformContext = createContext(DESKTOP_PLATFORM)
export const PlatformProvider = PlatformContext.Provider
export const usePlatform = (): Platform => useContext(PlatformContext)
