export const EXCERPT_MAX = 140

export function excerptOf(markdown: string, max = EXCERPT_MAX): string | undefined {
  const withoutFences = markdown.replace(/```[\s\S]*?(```|$)/g, '\n')
  const line = withoutFences
    .split('\n')
    .map((raw) =>
      raw
        .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__|\*|_|`|~~)(?=\S)([^*_`~]*?\S)\1/g, '$2')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .find((candidate) => candidate.length > 0 && !/^([-*_=|:\s])+$/.test(candidate))
  if (!line) return undefined
  if (line.length <= max) return line
  const cut = line.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`
}
