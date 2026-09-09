// Rebuild the social image with the site's own type and color tokens.
// No preview server or external network is needed.
import { chromium } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'

const site = new URL('../', import.meta.url)
const css = (await readFile(new URL('src/styles/global.css', site), 'utf8')).replace(
  "@import 'tailwindcss';",
  '',
)
const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  })
  await page.route('**/*', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/fonts/InterVariable.woff2' || path === '/fonts/JetBrainsMono.ttf') {
      await route.fulfill({
        body: await readFile(new URL(`public${path}`, site)),
        contentType: path.endsWith('woff2') ? 'font/woff2' : 'font/ttf',
      })
    } else {
      await route.abort()
    }
  })
  await page.setContent(`<!doctype html><html lang="en"><head>
    <base href="https://phosphor-social.local/"><meta charset="UTF-8"><style>${css}
    body { padding: 44px 56px; }
    header, footer { display: flex; align-items: center; justify-content: space-between; }
    header { border-bottom: 1px solid var(--line); padding-bottom: 28px; }
    main { padding-block: 46px; }
    h1 { font-size: 100px; }
    footer { border-top: 1px solid var(--line); padding-top: 24px; }
    .lede { margin-top: 24px; font-size: 22px; }
    </style></head><body>
    <header><div class="brand"><svg width="22" height="28" viewBox="300 180 540 660" fill="currentColor"><path d="M340 220 H560 C700 220 790 305 790 425 C790 545 700 630 560 630 H430 V800 H340 Z M430 310 H552 C640 310 700 355 700 425 C700 495 640 540 552 540 H430 Z" fill-rule="evenodd"/></svg>Phosphor</div><span class="label muted">The working record / 01</span></header>
    <main><h1 class="display">Keep the work<br>in your hands.</h1><p class="lede">A desktop workspace for coding with agents.</p></main>
    <footer class="label muted"><span>Direct → Inspect → Revise</span><span>Open source · Powered by pi</span></footer>
    </body></html>`)
  await page.evaluate('document.fonts.ready')
  const path = fileURLToPath(new URL('public/og.png', site))
  await page.screenshot({ path })
  console.log(`Wrote ${path}`)
} finally {
  await browser.close()
}
