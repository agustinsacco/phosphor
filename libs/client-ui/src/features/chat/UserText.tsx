import { parseUserText, type UserTextItem } from './userMessageBlocks'

/**
 * A sent user message.
 *
 * Lists render as lists (the composer can now write them); everything else is
 * the exact text that was sent, still `whitespace-pre-wrap`.
 */
export function UserText({ text }: { text: string }): React.JSX.Element {
  const blocks = parseUserText(text)
  return (
    <>
      {blocks.map((block, i) =>
        block.kind === 'text' ? (
          <span key={i} className="whitespace-pre-wrap">
            {block.text}
          </span>
        ) : block.listKind === 'bullet' ? (
          <ul key={i} className="my-1 list-disc space-y-0.5 pl-5" data-testid="user-list">
            {block.items.map((item, j) => (
              <Item key={j} item={item} />
            ))}
          </ul>
        ) : (
          <ol
            key={i}
            start={block.start}
            className="my-1 list-decimal space-y-0.5 pl-5"
            data-testid="user-list"
          >
            {block.items.map((item, j) => (
              <Item key={j} item={item} />
            ))}
          </ol>
        ),
      )}
    </>
  )
}

function Item({ item }: { item: UserTextItem }): React.JSX.Element {
  return (
    <li style={item.depth > 0 ? { marginLeft: `${item.depth * 1}rem` } : undefined}>
      {item.checked !== null && (
        <input
          type="checkbox"
          checked={item.checked}
          readOnly
          aria-hidden
          className="mr-1.5 align-middle"
        />
      )}
      <span className="whitespace-pre-wrap">{item.content}</span>
    </li>
  )
}
