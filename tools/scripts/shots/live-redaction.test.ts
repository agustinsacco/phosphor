// @vitest-environment jsdom
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { redactLivePage } from './live-redaction.mjs'

const observers: MutationObserver[] = []
afterEach(() => {
  observers.splice(0).forEach((observer) => observer.disconnect())
  Reflect.get(globalThis, '__shotRedactor')?.disconnect()
  Reflect.deleteProperty(globalThis, '__shotRedactor')
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function serializedRedactor(pairs: string[][]) {
  // Only browser globals and argument data: no imports or module lexical scope.
  const context = {
    document,
    NodeFilter,
    MutationObserver,
    pairs,
    __shotRedactor: undefined as MutationObserver | undefined,
  }
  const invoke = () => runInNewContext(`(${redactLivePage.toString()})(pairs)`, context)
  invoke()
  if (context.__shotRedactor) observers.push(context.__shotRedactor)
  return { context, invoke }
}
const mutationsDelivered = () => new Promise((resolve) => setTimeout(resolve, 0))

it('scrubs nested text with email masking before ordered literal replacements', () => {
  document.body.innerHTML =
    '<p>first.last+tag@company.test <b>internal.mcp internal.mcp</b></p><a title="private@company.test">another@host.co.uk</a>'
  redactLivePage([
    ['internal.mcp', 'knowledge'],
    ['knowledge', 'tools'],
    ['you@example.com', 'account'],
  ])
  expect(document.body.textContent).toBe('account tools toolsaccount')
  // The original contract is text-only; it does not rewrite attributes or HTML.
  expect(document.querySelector('a')?.title).toBe('private@company.test')
})

it('runs after browser serialization without module captures and scrubs later mutations', async () => {
  document.body.innerHTML = '<p>initial@private.test internal</p>'
  serializedRedactor([['internal', 'public']])
  expect(document.body.textContent).toBe('you@example.com public')
  const paragraph = document.querySelector('p')!
  paragraph.firstChild!.nodeValue = 'changed@private.test internal'
  const nested = document.createElement('section')
  nested.innerHTML = '<b>added@private.test internal</b>'
  document.body.append(nested, document.createTextNode('text@private.test internal'))
  await mutationsDelivered()
  expect(paragraph.textContent).toBe('you@example.com public')
  expect(nested.textContent).toBe('you@example.com public')
  expect(document.body.lastChild?.textContent).toBe('you@example.com public')
})

it('installs one observer across repeated shots while still running the immediate pass', async () => {
  const observe = vi.spyOn(MutationObserver.prototype, 'observe')
  const { context, invoke } = serializedRedactor([['internal', 'public']])
  const original = context.__shotRedactor
  document.body.append(document.createTextNode('internal new@private.test'))
  invoke()
  expect(document.body.textContent).toBe('public you@example.com')
  expect(context.__shotRedactor).toBe(original)
  expect(observe).toHaveBeenCalledExactlyOnceWith(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  })
  await mutationsDelivered()
  expect(document.body.textContent).toBe('public you@example.com')
})
