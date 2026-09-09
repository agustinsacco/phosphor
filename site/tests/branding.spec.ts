import { test, expect } from '@playwright/test'
import sharp from 'sharp'

// Inspect served pixels, not SVG source strings: a second drawing can look
// plausible while silently drifting from the generated favicon.
test('site lockups and social preview use the canonical beacon', async ({ page, request }) => {
  await page.goto('/')
  const marks = page.locator('.wordmark img')
  await expect(marks).toHaveCount(2)
  for (const mark of await marks.all()) {
    await expect(mark).toHaveAttribute('src', '/favicon.svg')
    await expect(mark).toHaveAttribute('alt', '')
    await expect(mark).toBeVisible()
  }

  const favicon = await request.get('/favicon.svg')
  const social = await request.get('/og.png')
  expect(favicon.ok()).toBe(true)
  expect(social.ok()).toBe(true)
  const socialBytes = await social.body()
  expect(await sharp(socialBytes).metadata()).toMatchObject({ width: 1200, height: 630 })

  // A fontless container renders tiny missing-glyph boxes while still producing
  // a valid PNG. The two large headline lines must actually fill their region.
  const headline = await sharp(socialBytes)
    .extract({ left: 55, top: 205, width: 620, height: 180 })
    .removeAlpha()
    .raw()
    .toBuffer()
  let inkPixels = 0
  for (let i = 0; i < headline.length; i += 3) {
    if (headline[i]! > 150 && headline[i + 1]! > 90) inkPixels++
  }
  expect(inkPixels, 'Social headline must render text, not missing-font boxes').toBeGreaterThan(
    8000,
  )

  const mark = await sharp(await favicon.body())
    .resize(64, 64)
    .png()
    .toBuffer()
  const background = await page
    .locator('html')
    .evaluate((html) => getComputedStyle(html).getPropertyValue('--px-bg').trim())
  const expected = await sharp({
    create: { width: 64, height: 64, channels: 4, background },
  })
    .composite([{ input: mark }])
    .ensureAlpha()
    .raw()
    .toBuffer()
  const actual = await sharp(socialBytes)
    .extract({ left: 60, top: 20, width: 64, height: 64 })
    .ensureAlpha()
    .raw()
    .toBuffer()
  expect(actual.equals(expected), 'Social mark pixels must match the canonical favicon').toBe(true)
})
