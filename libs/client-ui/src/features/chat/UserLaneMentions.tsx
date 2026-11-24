import { parseLaneHref } from '@/lib/laneMention'
import { LaneMentionChip } from './LaneMentionChip'
import type { ReactNode } from 'react'

/** User bubbles otherwise show literal text (including attached-file blocks), not Markdown. */
export function UserLaneMentions({ text }: { text: string }): ReactNode {
  if (!text.includes('](phosphor-lane:')) return text
  const chunks: ReactNode[] = []
  let end = 0
  for (const match of text.matchAll(/\[@((?:\\.|[^\\[\]\r\n])*)\]\((phosphor-lane:[^\s()]+)\)/g)) {
    const [, label, href] = match
    if (!parseLaneHref(href!)) continue
    chunks.push(
      text.slice(end, match.index),
      <LaneMentionChip key={match.index} href={href!}>
        @{label!.replace(/\\(.)/g, '$1')}
      </LaneMentionChip>,
    )
    end = match.index + match[0].length
  }
  chunks.push(text.slice(end))
  return chunks
}
