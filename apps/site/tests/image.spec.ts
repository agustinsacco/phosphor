import { expect, test } from '@playwright/test'

// Astro preview is useful locally, but directory/cache policy belongs to the control server.
test('production image retains direct guide resolution, static cache policy and real 404s', async ({
  request,
}) => {
  test.skip(!process.env.SITE_TEST_URL, 'Requires the served combined production Node image')
  for (const route of [
    '/guides',
    '/guides/daily-work',
    '/guides/accounts',
    '/guides/extensions',
    '/guides/connectors',
  ]) {
    const response = await request.get(route, { maxRedirects: 0 })
    // Existing try_files resolves $uri/index.html without a slash redirect.
    expect(response.status(), route).toBe(200)
    expect(response.headers().location, route).toBeUndefined()
    expect((await request.get(`${route}/`)).ok(), route).toBe(true)
  }

  // The old Claude guide URL moved; links to it, fragments included, still land.
  for (const route of ['/guides/claude-code', '/guides/claude-code/']) {
    const moved = await request.get(route, { maxRedirects: 0 })
    expect(moved.status(), route).toBe(301)
    expect(moved.headers().location, route).toBe('/guides/accounts/')
  }

  const landing = await request.get('/')
  expect(landing.headers()['x-content-type-options']).toBe('nosniff')
  expect(landing.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin')
  const html = await landing.text()
  const asset = html.match(/(?:src|href)="(\/_astro\/[^" ]+)"/)
  expect(asset).not.toBeNull()
  for (const path of [asset![1]!, '/fonts/InterVariable.woff2']) {
    const response = await request.get(path)
    expect(response.ok(), path).toBe(true)
    expect(response.headers()['cache-control'], path).toBe('public, max-age=31536000, immutable')
  }
  for (const path of [
    '/missing-page',
    '/guides/missing/',
    '/_astro/missing.png',
    '/fonts/missing.woff2',
  ]) {
    expect((await request.get(path)).status(), path).toBe(404)
  }
})
