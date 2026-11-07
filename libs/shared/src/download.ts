/**
 * Download without ever rendering: as `text/html` or SVG, a browser that
 * ignores `download` (iOS standalone PWAs) would open model-written content as
 * a page in the app's own origin. As an octet stream it can only be saved. The
 * URL is revoked late, because WebKit and older Firefox read it after the click
 * returns.
 */
export function downloadBytes(
  name: string,
  data: string | Uint8Array<ArrayBuffer>,
  type = 'application/octet-stream',
): void {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
