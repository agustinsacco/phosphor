/** Validate each entry without caching authorization; drain active checks before failing. */
export async function validateList(
  files: readonly string[],
  check: (file: string) => Promise<unknown>,
): Promise<void> {
  let next = 0
  let failed = false
  let failure: unknown
  const worker = async () => {
    while (!failed && next < files.length) {
      const file = files[next++]
      if (file === undefined) return
      try {
        await check(file)
      } catch (error) {
        if (!failed) failure = error
        failed = true
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, worker))
  if (failed) throw failure
}
