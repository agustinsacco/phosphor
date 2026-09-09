import { describe, it, expect } from 'vitest'
import { remarkArtifactLinks } from './remarkArtifactLinks'

interface Node {
  type: string
  value?: string
  url?: string
  children?: Node[]
}

/** One paragraph, the shape react-markdown hands a remark transformer. */
function paragraph(...children: Node[]): Node {
  return { type: 'root', children: [{ type: 'paragraph', children }] }
}

function transform(tree: Node): Node {
  remarkArtifactLinks()(tree)
  return tree
}

function inline(tree: Node): Node[] {
  return tree.children![0]!.children!
}

describe('remarkArtifactLinks', () => {
  it('promotes an inline-code artifact URL, keeping the code span', () => {
    const tree = transform(
      paragraph(
        { type: 'text', value: 'Delivered ' },
        { type: 'inlineCode', value: 'artifact://starfall-field-guide' },
        { type: 'text', value: '.' },
      ),
    )
    const [, link] = inline(tree)
    expect(link).toEqual({
      type: 'link',
      url: 'artifact://starfall-field-guide',
      children: [{ type: 'inlineCode', value: 'artifact://starfall-field-guide' }],
    })
  })

  it('promotes a bare artifact URL in prose and keeps the text around it', () => {
    const tree = transform(
      paragraph({ type: 'text', value: 'Open artifact://phosphor-beacon when ready.' }),
    )
    expect(inline(tree)).toEqual([
      { type: 'text', value: 'Open ' },
      {
        type: 'link',
        url: 'artifact://phosphor-beacon',
        children: [{ type: 'text', value: 'artifact://phosphor-beacon' }],
      },
      { type: 'text', value: ' when ready.' },
    ])
  })

  it('stops the URL before trailing punctuation, which is not part of the id', () => {
    const tree = transform(paragraph({ type: 'text', value: 'See artifact://beacon, or not.' }))
    expect(inline(tree)[1]!.url).toBe('artifact://beacon')
    const dotted = transform(paragraph({ type: 'text', value: 'See artifact://beacon.' }))
    expect(inline(dotted)[1]!.url).toBe('artifact://beacon')
  })

  it('keeps a version suffix, which classifyLink reads', () => {
    const tree = transform(paragraph({ type: 'inlineCode', value: 'artifact://beacon#v2' }))
    expect(inline(tree)[0]!.url).toBe('artifact://beacon#v2')
  })

  it('leaves a code span that merely mentions a URL alone', () => {
    const tree = transform(paragraph({ type: 'inlineCode', value: 'open artifact://beacon now' }))
    expect(inline(tree)).toEqual([{ type: 'inlineCode', value: 'open artifact://beacon now' }])
  })

  it('does not touch a URL that is already a link', () => {
    const tree = transform(
      paragraph({
        type: 'link',
        url: 'artifact://beacon',
        children: [{ type: 'text', value: 'artifact://beacon' }],
      }),
    )
    expect(inline(tree)[0]!.children).toEqual([{ type: 'text', value: 'artifact://beacon' }])
  })

  it('reaches nested inline content — a bold list item, as models write it', () => {
    const tree: Node = {
      type: 'root',
      children: [
        {
          type: 'list',
          children: [
            {
              type: 'listItem',
              children: [
                {
                  type: 'paragraph',
                  children: [
                    { type: 'strong', children: [{ type: 'text', value: 'Field Guide' }] },
                    { type: 'text', value: ': ' },
                    { type: 'inlineCode', value: 'artifact://field-guide' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    transform(tree)
    const item = tree.children![0]!.children![0]!.children![0]!.children!
    expect(item[2]!.type).toBe('link')
    expect(item[2]!.url).toBe('artifact://field-guide')
  })

  it('leaves markdown without an artifact URL structurally identical', () => {
    const children = [
      { type: 'text', value: 'See ' },
      { type: 'inlineCode', value: 'src/lib/rpc.ts' },
    ]
    const tree = paragraph(...children)
    const before = tree.children![0]!.children
    transform(tree)
    // Same array, not a rebuilt copy: an untouched message must not re-render.
    expect(tree.children![0]!.children).toBe(before)
  })
})
