import { test, expect } from './fixture'

/** Text-only magnification stress, not a claim of testing an OS accessibility setting. */
test('shared pages wrap at doubled text sizes and the composer follows a reduced viewport', async ({
  stack,
  page,
}, info) => {
  await page.setViewportSize({ width: 412, height: 924 })
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByTestId('home-board')).toBeVisible()
  for (const route of ['settings', 'machines']) {
    await page.goto(`${stack.origin}/pages/${route}`)
    await expect(page.locator('.page-shell h1')).toHaveCount(1)
    await page.evaluate(() => {
      const fonts = [...document.querySelectorAll<HTMLElement>('.page-shell *')].map((element) => ({
        element,
        size: parseFloat(getComputedStyle(element).fontSize),
      }))
      for (const { element, size } of fonts) element.style.fontSize = `${size * 2}px`
    })
    const widths = await page
      .locator('.page-body-content, .page-shell-header')
      .evaluateAll((elements) =>
        elements.map((element) => ({ width: element.clientWidth, scroll: element.scrollWidth })),
      )
    expect(
      widths.every((value) => value.scroll <= value.width + 1),
      JSON.stringify(widths),
    ).toBe(true)
    await page.screenshot({ path: info.outputPath(`${route}-doubled-text.png`), fullPage: true })
  }
  await page.goto(`${stack.origin}/new/${stack.hostId}`)
  await expect(page.getByTestId('remote-model-picker')).toBeVisible()
  await page.setViewportSize({ width: 412, height: 480 })
  await page.getByRole('textbox', { name: 'Chat message' }).focus()
  await expect
    .poll(() => page.locator('.browser-shell').evaluate((element) => element.clientHeight))
    .toBe(480)
  await expect(page.getByRole('button', { name: 'Start lane', exact: true })).toBeInViewport()
  await page.screenshot({ path: info.outputPath('reduced-keyboard-viewport.png'), fullPage: true })
})

test('a menu row keeps its whole label beside a long hint', async ({ stack, page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByTestId('home-board')).toBeVisible()
  await page.goto(`${stack.origin}/lanes/${stack.hostId}/${stack.laneId}/chat`)
  await page.getByRole('button', { name: 'Session options', exact: true }).click()
  // A Host lane this window does not control hints why on every control row.
  const row = page
    .getByTestId('context-menu')
    .getByRole('button')
    .filter({ hasText: 'Compact now…' })
  const label = row.locator('span').first()
  await expect(label).toHaveText('Compact now…')
  await expect(row.locator('span').nth(1)).not.toBeEmpty()
  const clipped = (el: Element) => el.clientWidth === 0 || el.scrollWidth > el.clientWidth + 1
  expect(await label.evaluate(clipped)).toBe(false)
  expect(await row.locator('span').nth(1).evaluate(clipped)).toBe(false)
  await page.screenshot({ path: info.outputPath('menu-long-hint-1440.png') })
})

test('the Host start composer shows the whole model name when there is room', async ({
  stack,
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByTestId('home-board')).toBeVisible()
  await page.goto(`${stack.origin}/new/${stack.hostId}`)
  const label = page.getByTestId('remote-model-picker').getByTestId('model-label')
  await expect(label).toContainText('HOST_A_ONLY')
  // The chip grows into the toolbar's free space, as This Mac's does, instead of its 4rem floor.
  const clipped = (el: Element) => el.clientWidth === 0 || el.scrollWidth > el.clientWidth + 1
  expect(await label.evaluate(clipped)).toBe(false)
  await page.screenshot({ path: info.outputPath('host-start-model-name.png') })
})

test('Markdown table cells keep words whole in a narrow panel', async ({ stack, page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByTestId('home-board')).toBeVisible()
  const url =
    'https://donnees.montreal.ca/api/3/action/datastore_search?resource_id=2b9dfc3d-91d3-48de-b32c-a2a6d9417079&q=Favard&limit=40&offset=20'
  const rows = [
    [
      'Assessment unit ID',
      'ID_UEV 01040804, matricule 0037',
      `Open data <a href="${url}">${url}</a>`,
      'Direct, high',
    ],
    ['Storeys above ground (ETAGE_HORS_SOL)', '2', 'same', 'Direct, high'],
    ['Year built (ANNEE_CONSTRUCTION)', '1875', 'same', 'Direct; the year is an estimate'],
  ]
  // The DOM MarkdownTable renders, so this pins the shared stylesheet both shells load.
  await page.evaluate((rows) => {
    const cells = (tag: string, row: string[]) =>
      `<tr>${row.map((cell) => `<${tag}>${cell}</${tag}>`).join('')}</tr>`
    const host = document.createElement('div')
    host.id = 'md-table-test'
    host.className = 'md-content'
    host.style.cssText =
      'position:fixed;inset:0 auto auto 0;width:380px;z-index:9999;background:var(--px-bg)'
    host.innerHTML = `<div class="md-table-wrap relative my-3"><div class="border-border overflow-x-auto rounded-lg border">
      <table class="md-table w-full border-collapse text-lg"><thead>${cells('th', ['Fact', 'Value', 'Source', 'Support / confidence'])}</thead>
      <tbody>${rows.map((row) => cells('td', row)).join('')}</tbody></table></div></div>`
    document.body.append(host)
  }, rows)
  const host = page.locator('#md-table-test')
  for (const width of [380, 1100]) {
    await host.evaluate((element, width) => (element.style.width = `${width}px`), width)
    // A word wrapped mid-word has more than one line box. Hyphens and links may break.
    const split = await host.evaluate((element) => {
      const broken: string[] = []
      const walker = document.createTreeWalker(
        element.querySelector('table')!,
        NodeFilter.SHOW_TEXT,
      )
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest('a')) continue
        for (const match of node.textContent!.matchAll(/[^\s-]+/g)) {
          const range = document.createRange()
          range.setStart(node, match.index)
          range.setEnd(node, match.index + match[0].length)
          if (range.getClientRects().length > 1) broken.push(match[0])
        }
      }
      return broken
    })
    expect(split, `mid-word breaks at ${width}px`).toEqual([])
    await page.screenshot({ path: info.outputPath(`markdown-table-${width}.png`) })
  }
  // At a wide panel the long link wraps instead of pushing the table past its frame.
  const scroller = host.locator('.overflow-x-auto')
  expect(await scroller.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
})
