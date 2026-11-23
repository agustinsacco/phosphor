import { execFileSync } from 'node:child_process'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, openWorkspace, shutdown } from './fixtures/local-app'
import { scratchDir } from './fixtures/scratch'

test('explorer shows ignored entries and opens a report through a symlink', async ({}, info) => {
  const repo = await scratchDir('phosphor-e2e-explorer-')
  const workspace = join(repo, 'lane')
  const artifacts = join(repo, 'artifacts')
  await mkdir(join(artifacts, 'reports'), { recursive: true })
  await mkdir(join(workspace, 'prompts'), { recursive: true })
  await mkdir(join(workspace, 'generated'))
  await mkdir(join(workspace, 'node_modules'))
  execFileSync('git', ['init', '-q'], { cwd: workspace })
  await writeFile(join(workspace, '.gitignore'), '/artifacts\n/generated/\n/node_modules/\n')
  await writeFile(join(workspace, 'prompts', 'report.md'), '# Prompt template')
  await writeFile(join(artifacts, 'reports', 'report.md'), '# Report from the linked folder')
  await symlink(artifacts, join(workspace, 'artifacts'), 'dir')
  const harness = await launch({ workspace })
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('explorerreport')
    await page.getByRole('button', { name: /Start lane/i }).click()
    const link = page.getByRole('link', { name: 'artifacts/reports/report.md', exact: true })
    await expect(link).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: /Files pane/ }).click()
    const explorer = page.getByTestId('file-explorer')
    const row = (name: string) => explorer.getByRole('button', { name, exact: true })
    await expect(row('prompts')).toBeVisible()
    await row('prompts').click()
    await expect(row('report.md')).toBeVisible()
    await info.attach('Explorer at open', {
      body: await explorer.screenshot(),
      contentType: 'image/png',
    })

    await expect(row('generated')).toHaveAttribute('aria-description', 'Git-ignored')
    await expect(row('node_modules')).toHaveAttribute('aria-expanded', 'false')
    await expect(row('.git')).toHaveCount(0)
    await expect(row('artifacts')).toHaveAttribute('aria-description', 'Git-ignored · Symlink')
    await row('artifacts').click()
    await row('reports').click()
    const report = explorer.locator('[data-path$="/artifacts/reports/report.md"]')
    await report.click()
    await expect(page.getByRole('heading', { name: 'Report from the linked folder' })).toBeVisible()
    await info.attach('Linked report open', {
      body: await page.getByTestId('right-pane').screenshot(),
      contentType: 'image/png',
    })

    const hideIgnored = row('Hide Git-ignored files')
    await hideIgnored.click()
    await expect(row('artifacts')).toHaveCount(0)
    await expect(row('generated')).toHaveCount(0)
    // Opening from chat must not depend on what the tree lists.
    await explorer.locator('[data-path$="/prompts/report.md"]').click()
    await link.click()
    await expect(page.getByRole('heading', { name: 'Report from the linked folder' })).toBeVisible()
    await hideIgnored.click()
    await expect(report).toBeVisible()
  } finally {
    await shutdown(harness)
    await rm(repo, { recursive: true, force: true })
  }
})
