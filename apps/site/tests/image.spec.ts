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
    '/guides/brain',
    '/guides/machines',
    '/guides/swarm',
    '/watch',
    '/privacy',
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
  // Download links count, then leave for the release; the redirect is fixed and uncached.
  for (const [path, target] of [
    ['/download/latest', 'https://github.com/agustinsacco/Phosphor/releases/latest'],
    [
      '/download/install-sh?next=https://example.com/',
      'https://github.com/agustinsacco/Phosphor/releases/latest/download/install.sh',
    ],
  ]) {
    const response = await request.get(path!, { maxRedirects: 0 })
    expect(response.status(), path).toBe(302)
    expect(response.headers().location, path).toBe(target)
    expect(response.headers()['cache-control'], path).toBe('no-store')
    expect(response.headers()['x-robots-tag'], path).toBe('noindex, nofollow')
  }
  const robots = await request.get('/robots.txt')
  expect(await robots.text()).toContain('Disallow: /download/')
  for (const path of [
    '/download/',
    '/download/mac',
    '/missing-page',
    '/guides/missing/',
    '/_astro/missing.png',
    '/fonts/missing.woff2',
  ]) {
    expect((await request.get(path)).status(), path).toBe(404)
  }
})

test('production media supports native playback MIME and seeking', async ({ request }) => {
  test.skip(!process.env.SITE_TEST_URL, 'Requires the production static server')
  for (const stem of ['phosphor-overview', 'brain-walkthrough', 'lane-to-review']) {
    const response = await request.get(`/media/${stem}.mp4`, {
      headers: { Range: 'bytes=0-31' },
    })
    expect(response.status()).toBe(206)
    expect(response.headers()['content-type']).toMatch(/^video\/mp4/)
    expect(response.headers()['accept-ranges']).toBe('bytes')
    expect(response.headers()['content-range']).toMatch(/^bytes 0-31\/\d+$/)
    expect((await response.body()).length).toBe(32)
    expect((await request.get(`/media/${stem}.webp`)).headers()['content-type']).toMatch(
      /^image\/webp/,
    )
  }
})
