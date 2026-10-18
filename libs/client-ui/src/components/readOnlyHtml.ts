/** Static browser artifacts never acquire scripts, an origin, forms, or network reach. */
export function readOnlyHtml(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  template.content
    .querySelectorAll(
      'script, iframe, frame, object, embed, base, meta, link, form, animate, animateMotion, animateTransform, set',
    )
    .forEach((node) => node.remove())
  for (const element of template.content.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (
        /^on/i.test(attribute.name) ||
        [
          'href',
          'xlink:href',
          'action',
          'formaction',
          'srcdoc',
          'srcset',
          'target',
          'ping',
        ].includes(attribute.name)
      )
        element.removeAttribute(attribute.name)
    }
  }
  return (
    "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; connect-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'\">" +
    template.innerHTML
  )
}
