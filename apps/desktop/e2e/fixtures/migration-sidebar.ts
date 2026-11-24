import { expect, type Page } from '@playwright/test'
import type { migrationWorld } from './migration-world'

/** The ordered visible rows, not the migration plan or the stores that populated them. */
export async function sidebarRows(
  page: Page,
  world: Awaited<ReturnType<typeof migrationWorld>>,
  service: boolean,
) {
  const rows = page.locator('aside').getByTestId(service ? 'remote-session-row' : 'session-row')
  for (const lane of Object.values(world.lanes))
    await expect(rows.filter({ hasText: lane.name })).toBeVisible()
  return rows.evaluateAll((nodes) =>
    nodes.map((row) => ({
      title: row.getAttribute('data-tooltip'),
      group: row.closest('section')?.getAttribute('aria-label') ?? 'Pinned',
      marker: row.querySelector('[data-testid="lane-marker"]')?.textContent,
    })),
  )
}
