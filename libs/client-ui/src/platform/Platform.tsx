import { createContext, useContext } from 'react'

/** UI capabilities only. Host authorization remains in the adapter and Host. */
export interface Platform {
  formFactor: 'expanded' | 'compact'
  localLanes: boolean
  fileEditing: boolean
  terminal: boolean
  scriptedArtifacts: boolean
  nativeFiles: boolean
}
export const DESKTOP_PLATFORM: Platform = Object.freeze({
  formFactor: 'expanded',
  localLanes: true,
  fileEditing: true,
  terminal: true,
  scriptedArtifacts: true,
  nativeFiles: true,
})
export const COMPACT_PLATFORM: Platform = Object.freeze({
  formFactor: 'compact',
  localLanes: false,
  fileEditing: false,
  terminal: false,
  scriptedArtifacts: false,
  nativeFiles: false,
})
const PlatformContext = createContext(DESKTOP_PLATFORM)
export const PlatformProvider = PlatformContext.Provider
export const usePlatform = (): Platform => useContext(PlatformContext)
