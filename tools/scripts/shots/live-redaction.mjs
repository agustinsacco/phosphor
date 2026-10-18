/** Self-contained: Playwright serializes this function into the renderer. */
export function redactLivePage(pairs) {
  // Runs in the renderer; globalThis keeps node's lint config honest.
  const { document, NodeFilter, MutationObserver } = globalThis
  const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
  const scrub = (node) => {
    const text = pairs.reduce(
      (acc, [from, to]) => acc.split(from).join(to),
      node.nodeValue.replace(email, 'you@example.com'),
    )
    if (text !== node.nodeValue) node.nodeValue = text
  }
  const scrubTree = (root) => {
    if (root.nodeType === 3) return scrub(root)
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) scrub(node)
  }
  scrubTree(document.body)
  if (globalThis.__shotRedactor) return
  globalThis.__shotRedactor = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') scrub(record.target)
      else record.addedNodes.forEach(scrubTree)
    }
  })
  globalThis.__shotRedactor.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  })
}
