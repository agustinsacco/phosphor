/** pi custom models need not be present in the catalogue. */
export function machineAgentModel(value: string): [string, string] | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every(
        (part) =>
          typeof part === 'string' &&
          part.trim().length > 0 &&
          part.length <= 200 &&
          !part.includes('\0'),
      )
      ? (parsed as [string, string])
      : null
  } catch {
    return null
  }
}
