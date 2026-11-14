export function fold(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ')
}
export function tokens(value: string): string[] {
  return fold(value).match(/[\p{L}\p{N}_]+/gu) ?? []
}
export function wholePhrase(text: string, phrase: string): boolean {
  const escaped = fold(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    !!escaped &&
    new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(fold(text))
  )
}

/** Whole-word matching also retains punctuation inside names such as C++ and C#. */
export function mentions(text: string, names: string[]): boolean {
  return names.some((name) => wholePhrase(text, name))
}
