import { expect, test } from '@playwright/test'

const newRoutes = ['/guides/brain/', '/guides/machines/', '/watch/']

for (const route of newRoutes) {
  test(`${route}: current guide is linked and usable without client scripts`, async ({ page }) => {
    const response = await page.goto(route)
    expect(response?.ok()).toBe(true)
    await expect(page.locator('h1')).toHaveCount(1)
    await expect(page.locator('script, astro-island')).toHaveCount(0)
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `https://phosphor.saccolabs.com${route}`,
    )
    await page.goto('/')
    expect(await page.locator(`a[href="${route}"]`).count()).toBeGreaterThan(0)
  })
}

test('Brain describes opt-in, saved reads, provider extraction and machine-local recall', async ({
  page,
}) => {
  await page.goto('/guides/brain/')
  for (const text of [
    'off by default',
    'Desktop-only',
    'Settings → Brain',
    'What changed',
    'How it was read',
    'Tell Brain Agent',
    'Defrag',
    'Queue for knowledge extraction',
    'brain_search',
    'provider',
    'does not sync',
    'Forget',
    'Reset',
  ]) {
    await expect(page.locator('main')).toContainText(text)
  }
  await expect(page.locator('#setup .capture')).toHaveCount(1)
  await expect(page.locator('#explore .capture')).toHaveCount(1)
})

test('Machines explains private transport, explicit control and snapshot moves', async ({
  page,
}) => {
  await page.goto('/guides/machines/')
  for (const text of [
    'Tailscale',
    'fingerprint',
    'Take control',
    'not a cloud runner',
    'original',
    'not resumed automatically',
    'credentials',
    'holding the copy only in the page',
  ]) {
    await expect(page.locator('main')).toContainText(text)
  }
  await expect(page.locator('#browser')).toContainText('Brain')
})

test('daily work distinguishes PR drafts, Slack links and notification boundaries', async ({
  page,
}) => {
  await page.goto('/guides/daily-work/')
  await expect(page.locator('#merge')).toContainText('nothing is sent')
  await expect(page.locator('#merge')).toContainText('no checks')
  await expect(page.locator('#slack')).toContainText('not an inbox')
  await expect(page.locator('#slack')).toContainText('settled assistant')
  await expect(page.locator('#notifications')).toContainText('This Mac')
  await expect(page.locator('#moves')).toContainText('snapshot')
})

test('watch films are opt-in, self-hosted and have visible text alternatives', async ({
  page,
  request,
}) => {
  const mediaRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('.mp4')) mediaRequests.push(request.url())
  })
  await page.goto('/watch/')
  const videos = page.locator('video')
  await expect(videos).toHaveCount(3)
  expect(mediaRequests, 'No movie bytes are requested before choosing playback').toEqual([])
  for (const [index, stem] of [
    'phosphor-overview',
    'brain-walkthrough',
    'lane-to-review',
  ].entries()) {
    const video = videos.nth(index)
    await expect(video).toHaveAttribute('controls', '')
    await expect(video).toHaveAttribute('preload', 'none')
    await expect(video).not.toHaveAttribute('autoplay')
    await expect(video).not.toHaveAttribute('loop')
    await expect(video).toHaveAttribute('poster', `/media/${stem}.webp`)
    await expect(video.locator('source')).toHaveAttribute('src', `/media/${stem}.mp4`)
    expect((await request.get(`/media/${stem}.webp`)).ok()).toBe(true)
    const response = await request.get(`/media/${stem}.mp4`, { headers: { Range: 'bytes=0-1023' } })
    expect(response.ok()).toBe(true)
    const section = page.locator(`#${stem}`)
    await expect(section.locator('ol')).toBeVisible()
    await expect(section).toContainText('Silent')
    await expect(section).toContainText('demo fixtures')
  }
})

test('privacy covers Brain provider calls and self-hosted films without tracking', async ({
  page,
}) => {
  await page.goto('/privacy/')
  await expect(page.locator('#brain')).toContainText('provider')
  await expect(page.locator('#brain')).toContainText('local')
  await expect(page.locator('#site')).toContainText('video')
})
