/** Cache the actual artifact mode, not whether a native build happened in the past. */
export function createHostFixtureBuilder(ports: {
  build: (native?: string) => void
  native: (build: (native: string) => void) => Promise<void>
}) {
  let built = false
  let hasNative = false
  const { build } = ports
  return async (native = false): Promise<void> => {
    if (built && native === hasNative) return
    if (native) await ports.native(build)
    else build()
    built = true
    hasNative = native
  }
}
