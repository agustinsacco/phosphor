/** A flag's key names the memory the lane flagged, and keeps naming it when a fold moves the flag. */
export function flagKey(memoryId: string, sessionId: string): string {
  return `${flagKeyPrefix(memoryId)}${Buffer.from(sessionId).toString('hex')}`
}
export function flagKeyPrefix(memoryId: string): string {
  return `flag:${Buffer.from(memoryId).toString('hex')}.`
}
