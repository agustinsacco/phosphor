import type { BrowserContext, Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { test, expect, browserFixture } from './fixture'

async function denyNonlocal(
  context: BrowserContext,
  origin: string,
  additionalOrigins: readonly string[] = [],
) {
  const escaped: string[] = []
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (
      url.origin === origin ||
      additionalOrigins.includes(url.origin) ||
      ['blob:', 'data:'].includes(url.protocol)
    )
      return route.continue()
    escaped.push(url.origin + url.pathname)
    await route.abort('blockedbyclient')
  })
  return escaped
}
/** A cached path that is not static shell. Hashed build assets are named after
 * their modules (a `lanePrefs` chunk is code, not lane data), so they are exempt. */
const privatePath = (path: string) =>
  !/^\/assets\/[^/]+-[\w-]{6,}\.(?:js|css|woff2?|png|svg|webp)$/.test(path) &&
  /api|auth|lane|fixture-host/.test(path)
async function signIn(page: Page, origin: string) {
  await page.goto(origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByTestId('compact-shell')).toBeVisible()
}
/** The left navigation: the wide column, or the phone drawer opened from the list. */
async function openNavigation(page: Page) {
  const compact = (page.viewportSize()?.width ?? 400) < 900
  await expect(page.locator('html')).toHaveAttribute(
    'data-form-factor',
    compact ? 'compact' : 'expanded',
  )
  if (!compact) return page.locator('aside.browser-navigation')
  // A phone's lane header has only Back and the lane menu; the drawer is on the list.
  const back = page.getByRole('button', { name: 'Back to lanes', exact: true })
  if (await back.isVisible()) await back.click()
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  return page.getByRole('dialog', { name: 'Navigation', exact: true })
}
async function navigatePage(page: Page, name: string) {
  const navigation = await openNavigation(page)
  // Settings is the account footer's gear, as on Desktop; the rest are Main navigation rows.
  await (
    name === 'Settings'
      ? navigation.getByRole('button', { name: 'Settings', exact: true })
      : navigation
          .getByRole('navigation', { name: 'Main navigation' })
          .getByRole('button', { name, exact: true })
  ).click()
}
/** The lane tree is in the navigation, under the machine scope; there is no Lanes link. */
async function openNavigationLane(page: Page, title: string) {
  const navigation = await openNavigation(page)
  await navigation.getByRole('button', { name: title, exact: true }).click()
}
async function openPane(page: Page, name: string) {
  if ((page.viewportSize()?.width ?? 400) < 900)
    await page.getByRole('button', { name: /^Lane menu/ }).click()
  await page
    .getByRole('navigation', { name: 'Lane panes' })
    .getByRole('button', { name, exact: true })
    .click()
}
async function openLane(page: Page, title = 'Synthetic acceptance lane') {
  await page.getByRole('button', { name: title, exact: true }).click()
  await expect(page.getByText('No controller', { exact: true })).toBeVisible()
}

test('production bootstrap: anonymous cookie boundary and anonymous service-worker shell', async ({
  page,
  context,
}, info) => {
  const stack = await browserFixture(true)
  try {
    const escaped = await denyNonlocal(context, stack.origin)
    await page.goto(stack.origin)
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible()
    await expect(page.getByTestId('compact-shell')).toHaveCount(0)
    expect(await page.evaluate(() => document.cookie)).toBe('')
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready
      if (!navigator.serviceWorker.controller)
        await new Promise<void>((done) =>
          navigator.serviceWorker.addEventListener('controllerchange', () => done(), {
            once: true,
          }),
        )
      await fetch('/api/auth/session')
      await fetch('/api/v1/machines')
    })
    // A first visit loads assets before worker activation. Warm the shell under
    // the controller before asserting offline availability (not first-install prefetch).
    await page.reload()
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible()
    const cached = await page.evaluate(async () => {
      const entries = await Promise.all(
        (await caches.keys()).map(async (key) =>
          (await (await caches.open(key)).keys()).map((r) => new URL(r.url).pathname),
        ),
      )
      return entries.flat()
    })
    await writeFile(info.outputPath('cached-paths.json'), JSON.stringify(cached, null, 2))
    const offlineFailures: string[] = []
    page.on('requestfailed', (request) => offlineFailures.push(new URL(request.url()).pathname))
    expect(cached).toContain('/')
    expect(cached.some(privatePath)).toBe(false)
    // Cut the disposable server rather than WebKit's offline emulation, which
    // can abort a navigation before the service worker sees its fetch failure.
    stack.state.offline = true
    try {
      await page.reload()
      await expect(page.getByRole('alert')).toHaveText(
        'Phosphor could not start. Check your connection and try again.',
      )
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toHaveCount(0)
    } finally {
      await writeFile(
        info.outputPath('offline-failed-paths.json'),
        JSON.stringify(offlineFailures, null, 2),
      )
    }
    await expect(page.getByTestId('compact-shell')).toHaveCount(0)
    expect(escaped).toEqual([])
  } finally {
    stack.state.offline = false
    await stack.close()
  }
})

test('production app refuses same-origin and cross-origin framing independently of parent CSP', async ({
  page,
  context,
}, info) => {
  const stack = await browserFixture(true)
  try {
    const crossOrigin = stack.origin.replace('127.0.0.1', 'localhost')
    const escaped = await denyNonlocal(context, stack.origin, [crossOrigin])
    // Positive control: this exact production child is renderable as a top-level page.
    const response = await page.goto(stack.origin)
    expect(response?.headers()['x-frame-options']).toBe('DENY')
    await expect(page.getByRole('heading', { name: 'Phosphor', exact: true })).toBeVisible()
    const refused: string[] = []
    for (const [kind, origin] of [
      ['same-origin', stack.origin],
      ['cross-origin', crossOrigin],
    ]) {
      const refusal = page.waitForEvent('console', {
        predicate: (message) => /X-Frame-Options/i.test(message.text()),
      })
      await page.goto(`${origin}/fixture-embed`)
      await refusal
      await expect(page.getByRole('heading', { name: 'Synthetic frame probe' })).toBeVisible()
      await expect(page.frameLocator('iframe').locator('#root')).toHaveCount(0)
      refused.push(kind!)
    }
    expect(escaped).toEqual([])
    await writeFile(info.outputPath('embedding-denied.json'), JSON.stringify(refused))
  } finally {
    await stack.close()
  }
})

test('cookie/CSRF → verified Host → read/control/send; waiting update and owner cleanup', async ({
  stack,
  page,
  context,
}, info) => {
  const escaped = await denyNonlocal(context, stack.origin)
  await signIn(page, stack.origin)
  const cookies = await context.cookies()
  const session = cookies.find((cookie) => cookie.name === 'phosphor-dev-session')
  expect(session?.httpOnly).toBe(true)
  expect(session?.sameSite).toBe('Lax')
  expect(await page.evaluate(() => document.cookie)).not.toContain('phosphor-dev-session')
  // Same real mutation handler, with deliberately missing CSRF. Must not log out.
  expect(
    await page.evaluate(
      async () =>
        (
          await fetch('/api/auth/signout', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
    ),
  ).toBe(403)
  await openLane(page)
  expect(stack.state.grants).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Release control', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Take control', exact: true }).click()
  await expect(page.getByText('Controlled by you', { exact: true })).toBeVisible()
  await page.locator('textarea').fill('PHX-browserAcceptance')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByText('PHX-browserAcceptance', { exact: true })).toHaveCount(2)
  const previousConnections = stack.state.connections
  stack.interruptHost()
  await expect.poll(() => stack.state.closedConnections).toBeGreaterThan(0)
  await page.evaluate((hostId) => window.phosphor.invoke('hosts:reconnect', hostId), stack.hostId)
  await expect.poll(() => stack.state.connections).toBeGreaterThan(previousConnections)
  await expect(page.getByText('Controlled by you', { exact: true })).toBeVisible()
  await expect(page.getByText('PHX-browserAcceptance', { exact: true })).toHaveCount(2)

  for (const width of [400, 1100]) {
    await page.setViewportSize({ width, height: 850 })
    for (const theme of ['light', 'dark']) {
      await navigatePage(page, 'Settings')
      await page
        .getByRole('button', { name: theme === 'light' ? 'Light' : 'Dark', exact: true })
        .click()
      await openNavigationLane(page, 'Synthetic acceptance lane')
      await expect(page.getByText('Controlled by you', { exact: true })).toBeVisible()
      await expect(page.getByText('PHX-browserAcceptance', { exact: true })).toHaveCount(2)
      await expect(page.getByText('PHX-browserAcceptance', { exact: true }).last()).toBeVisible()
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      await page.screenshot({
        path: info.outputPath(`compact-${width}-${theme}.png`),
        animations: 'disabled',
        fullPage: true,
      })
    }
  }

  await page.locator('textarea').fill('UNSENT_OWNER_A_SYNTHETIC_DRAFT')
  stack.state.workerRevision++
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    const installed = new Promise<void>((done) => {
      registration.addEventListener(
        'updatefound',
        () => {
          const worker = registration.installing!
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed') done()
          })
        },
        { once: true },
      )
    })
    await registration.update()
    await installed
  })
  expect(
    await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting),
  ).toBe(true)
  await expect(page.locator('textarea')).toHaveValue('UNSENT_OWNER_A_SYNTHETIC_DRAFT')
  const cached = await page.evaluate(async () => {
    const cachesFound = await Promise.all(
      (await caches.keys()).map(async (key) => {
        const cache = await caches.open(key)
        return Promise.all(
          (await cache.keys()).map(async (request) => ({
            path: new URL(request.url).pathname,
            body: await (await cache.match(request))!.text(),
          })),
        )
      }),
    )
    return cachesFound.flat()
  })
  expect(cached.length).toBeGreaterThan(0)
  expect(cached.some(({ path }) => privatePath(path))).toBe(false)
  expect(
    cached.some(({ body }) =>
      /UNSENT_OWNER_A_SYNTHETIC_DRAFT|PHX-browserAcceptance|HOST_A_ONLY synthetic file/.test(body),
    ),
  ).toBe(false)
  await writeFile(
    info.outputPath('authenticated-cached-paths.json'),
    JSON.stringify(
      cached.map(({ path }) => path),
      null,
      2,
    ),
  )
  // Persist through real composer unmount, not a test-written store record.
  await page.getByRole('button', { name: 'Back to lanes' }).click()
  await expect
    .poll(() =>
      page.evaluate(async () =>
        Object.values(await window.phosphor.invoke('app:sweepDrafts')).some(
          (d) => d.text === 'UNSENT_OWNER_A_SYNTHETIC_DRAFT',
        ),
      ),
    )
    .toBe(true)
  await navigatePage(page, 'Settings')
  await page
    .getByRole('navigation', { name: 'Settings sections', exact: true })
    .getByRole('button', { name: 'Phosphor account', exact: true })
    .click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible()
  await expect.poll(() => stack.state.closedConnections).toBe(stack.state.connections)
  expect(await page.evaluate(() => window.phosphor.invoke('app:sweepDrafts'))).toEqual({})
  stack.state.owner = stack.owners[1]!
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click()
  await expect(page.getByTestId('compact-shell')).toBeVisible()
  await expect(page.getByText('No machines yet. Add a Host from Machines.')).toBeVisible()
  expect(await page.evaluate(() => window.phosphor.invoke('app:sweepDrafts'))).toEqual({})
  await expect(page.getByText('UNSENT_OWNER_A_SYNTHETIC_DRAFT')).toHaveCount(0)
  await page.goto(`${stack.origin}/lanes/${stack.hostId}/${stack.laneId}/chat`)
  await expect(page.getByText('This machine is no longer in your account.')).toBeVisible()
  expect(escaped).toEqual([])
})

test('signout and owner switch discard an outstanding real Host approval', async ({
  stack,
  page,
  context,
}) => {
  const escaped = await denyNonlocal(context, stack.origin)
  await signIn(page, stack.origin)
  await openLane(page)
  await page.getByRole('button', { name: 'Take control', exact: true }).click()
  await expect(page.getByText('Controlled by you', { exact: true })).toBeVisible()
  await page.locator('textarea').fill('/fake-ask')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByText('The fake asks', { exact: true })).toBeVisible()
  // The real public adapter action simulates account loss while the modal is up;
  // no test reaches into the dialog store or answers the old owner's question.
  await page.evaluate(() => window.phosphor.invoke('account:signOut'))
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible()
  await expect(page.getByText('The fake asks', { exact: true })).toHaveCount(0)
  stack.state.owner = stack.owners[1]!
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click()
  await expect(page.getByTestId('compact-shell')).toBeVisible()
  await expect(page.getByText('The fake asks', { exact: true })).toHaveCount(0)
  expect(escaped).toEqual([])
})

test('real Host files and artifact isolation across two lanes', async ({
  stack,
  page,
  context,
}) => {
  const escaped = await denyNonlocal(context, stack.origin)
  await signIn(page, stack.origin)
  await openLane(page)
  await openPane(page, 'Files')
  await page.getByRole('treeitem', { name: 'remote.txt', exact: true }).click()
  await expect(page.getByText('HOST_A_ONLY synthetic file', { exact: false })).toBeVisible()
  await expect(page.getByText('HOST_B_ONLY synthetic file', { exact: false })).toHaveCount(0)
  await openPane(page, 'Artifacts')
  await expect(
    page.frameLocator('iframe').getByRole('heading', { name: 'HOST_A_ONLY version 1' }),
  ).toBeVisible()
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', '')
  await page.getByRole('button', { name: 'Back to lanes' }).click()
  await openLane(page, 'Second synthetic lane')
  await openPane(page, 'Files')
  await page.getByRole('treeitem', { name: 'remote.txt', exact: true }).click()
  await expect(page.getByText('HOST_B_ONLY synthetic file', { exact: false })).toBeVisible()
  await expect(page.getByText('HOST_A_ONLY synthetic file', { exact: false })).toHaveCount(0)
  await openPane(page, 'Artifacts')
  await expect(
    page.frameLocator('iframe').getByRole('heading', { name: 'HOST_B_ONLY version 1' }),
  ).toBeVisible()
  await expect(page.frameLocator('iframe').getByText('HOST_A_ONLY', { exact: false })).toHaveCount(
    0,
  )

  expect(escaped).toEqual([])
})

test('actual compact SandboxedHtml contains hostile HTML/SVG without script, network or navigation', async ({
  stack,
  page,
  context,
}, info) => {
  const escaped = await denyNonlocal(context, stack.origin)
  const policyErrors: string[] = []
  page.on('console', (message) => {
    if (
      policyErrors.length < 32 &&
      /Content Security|Content-Security|Refused|Not allowed|Blocked/i.test(message.text())
    )
      policyErrors.push(
        message
          .text()
          .replace(/data:[^\s'"]+/g, 'data:[omitted]')
          .slice(0, 1000),
      )
  })
  const dialogs: string[] = []
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.type())
    await dialog.dismiss()
  })
  await page.goto(`${stack.origin}/sandbox`)
  const frame = page.frameLocator('iframe[title="Hostile synthetic preview"]')
  try {
    await expect(frame.getByRole('heading', { name: 'Safe synthetic preview' })).toBeVisible()
  } finally {
    await writeFile(
      info.outputPath('preview-policy-errors.json'),
      JSON.stringify(policyErrors, null, 2),
    )
  }
  await expect(frame.getByText('Safe SVG text')).toBeVisible()
  await expect(frame.locator('#safe')).toHaveText('Readable content remains')
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', '')
  await expect(page.locator('iframe')).toHaveAttribute('src', /^blob:/)
  await expect(
    frame.locator('script, iframe, form, meta[http-equiv="refresh"], animate'),
  ).toHaveCount(0)
  await frame.getByText('Attempt navigation', { exact: true }).click()
  await expect(frame.locator('svg a')).not.toHaveAttribute('href')
  // WebKit reports overlapping text hit boxes for SVG text nodes. Click the
  // authored link position in the fixed-size SVG instead of forcing a text click.
  await frame.locator('svg').click({ position: { x: 30, y: 45 } })
  await expect(page).toHaveURL(`${stack.origin}/sandbox`)
  await expect(frame.locator('#safe')).toHaveText('Readable content remains')
  expect(context.pages()).toHaveLength(1)
  expect(dialogs).toEqual([])
  expect(escaped).toEqual([])
})
