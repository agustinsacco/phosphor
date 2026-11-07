import { createSessionPathRuntime } from '@phosphor/session-runtime/pi/session-path-lock'

/** The Desktop owner shares this lock domain across startup and deletion. */
export const sessionPaths = createSessionPathRuntime()
export const { openSessionPath, cancelSessionOpens, withSessionPath } = sessionPaths
