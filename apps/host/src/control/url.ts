/** Control traffic goes only to a configured bare origin, never a redirect. */
export function isControlUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return (
      value === url.origin &&
      !url.username &&
      !url.password &&
      (url.port === '' || (Number(url.port) >= 1 && Number(url.port) <= 65_535)) &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
  } catch {
    return false
  }
}
