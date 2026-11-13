/** Temporary until the parallel engine worker exports memory-engine/text. */
export function fold(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ')
}
export function tokens(value: string): string[] {
  return fold(value).match(/[\p{L}\p{N}_]+/gu) ?? []
}
export function mentions(text: string, name: string): boolean {
  const escaped = fold(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    !!escaped &&
    new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(fold(text))
  )
}
