import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const root = join(import.meta.dirname, '..')
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory()
      ? sources(path)
      : entry.name.endsWith('.tsx') && !entry.name.includes('.test.')
        ? [path]
        : []
  })
}

describe('shared tooltip coverage', () => {
  it('keeps app buttons on the shared primitive and native titles only on named frames', () => {
    const violations: string[] = []
    for (const path of sources(root)) {
      const name = relative(root, path)
      if (name === 'components/Tooltip.tsx') continue
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      )
      function visit(node: ts.Node): void {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText(source)
          const nativeTitle =
            /^[a-z]/.test(tag) &&
            tag !== 'iframe' &&
            node.attributes.properties.some(
              (attr) => ts.isJsxAttribute(attr) && attr.name.getText(source) === 'title',
            )
          if (tag === 'button' || tag === 'summary' || nativeTitle) {
            violations.push(
              `${name}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}: use the shared tooltip primitives/props`,
            )
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(violations).toEqual([])
  })
})
