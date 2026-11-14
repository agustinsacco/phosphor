/** Bound background fan-out without queueing unrelated interactive operations. */
export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  visit: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency')
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await visit(items[index]!, index)
    }
  }
  // Drain started workers even after one fails; callers must not start a
  // replacement sweep while the previous sweep still owns child processes.
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  )
  const failure = outcomes.find((outcome) => outcome.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
  return results
}
