import { Markdown } from '@/components/markdown/Markdown'

/** Keep authored prose as Markdown; make a whole structured payload readable as JSON. */
export function SubagentText({ text }: { text: string }): React.JSX.Element {
  let formatted = text
  if (text.length < 200_000 && ['{', '['].includes(text.trimStart()[0] ?? '')) {
    try {
      const value: unknown = JSON.parse(text)
      if (value !== null && typeof value === 'object')
        formatted = `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
    } catch {
      /* Not a whole JSON value: preserve the original Markdown. */
    }
  }
  return <Markdown text={formatted} inAppLinks={false} />
}
