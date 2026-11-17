import { shot, settings, closeSettings } from './capture-harness.mjs'

export async function captureSettings(page) {
  for (const [tab, name] of [
    ['appearance', 'settings'],
    ['accounts', 'accounts'],
    ['extensions', 'guide-extensions'],
    ['claude-provider', 'guide-claude'],
    ['connectors', 'guide-connectors'],
    ['agent', 'guide-agent'],
    ['lanes', 'guide-lanes'],
    ['subagents', 'guide-subagents'],
  ]) {
    await settings(page, tab)
    await shot(page, name, page.getByRole('dialog', { name: 'Settings', exact: true }))
    if (name === 'guide-connectors')
      await shot(page, 'connectors', page.getByRole('dialog', { name: 'Settings', exact: true }))
  }
  await settings(page, 'claude-provider')
  const routing = page.getByText('Route new sessions', { exact: true })
  await routing.scrollIntoViewIfNeeded()
  await shot(page, 'guide-routing', page.getByRole('dialog', { name: 'Settings', exact: true }))
  await closeSettings(page)
}
