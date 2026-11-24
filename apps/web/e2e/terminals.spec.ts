import { test, expect } from './fixture'

// This fixture has no native node-pty. It proves new clients still render a useful
// refusal for older/non-terminal Hosts, without attempting a local browser shell.
for (const width of [400, 1440]) {
  test(`terminal is a lane pane at ${width}px and missing Host support is explicit`, async ({
    stack,
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 })
    await page.goto(stack.origin)
    await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
    await expect(page.getByTestId('home-board')).toBeVisible()
    await page.goto(`${stack.origin}/lanes/${stack.hostId}/${stack.laneId}/terminal`)
    await expect(page.getByText('This Host does not offer terminals to this device.')).toBeVisible()
    if (width < 900) await page.getByRole('button', { name: /^Lane menu/ }).click()
    await expect(
      page
        .getByRole('navigation', { name: 'Lane panes' })
        .getByRole('button', { name: 'Terminal', exact: true }),
    ).toBeVisible()
    await page.goto(`${stack.origin}/pages/machines`)
    await page.getByRole('button', { name: /Synthetic Host/ }).click()
    // The machine's shell is a view of its own, and the refusal is shown there.
    await page
      .getByRole('navigation', { name: 'Machine views' })
      .getByRole('button', { name: 'Terminal', exact: true })
      .click()
    const terminal = page.getByTestId('machine-terminal')
    await expect(terminal).toContainText('This device may not open terminals on Synthetic Host.')
    await expect(terminal.getByRole('button', { name: 'New terminal' })).toHaveCount(0)
  })
}
