import { defineConfig } from '@playwright/test'

// CI exercises nginx's production image; local runs start Astro's preview.
const externalURL = process.env.SITE_TEST_URL

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: 'list',
  use: {
    baseURL: externalURL || 'http://127.0.0.1:4322',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: externalURL
    ? undefined
    : {
        command: 'npm run preview -- --host 127.0.0.1 --port 4322',
        url: 'http://127.0.0.1:4322',
        reuseExistingServer: !process.env.CI,
      },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
    {
      name: 'no-js-desktop',
      use: { javaScriptEnabled: false, viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'no-js-mobile',
      use: {
        javaScriptEnabled: false,
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'reduced-motion',
      use: { reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } },
    },
  ],
})
