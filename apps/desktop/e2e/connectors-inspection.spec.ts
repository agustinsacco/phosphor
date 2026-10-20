import { test, expect } from '@playwright/test'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, openWorkspace, shutdown, privateAgentDir } from './fixtures/local-app'
import { scratchDir } from './fixtures/scratch'

test('Connectors: partial tests, cached descriptions and external config refresh', async () => {
  const agent = privateAgentDir()
  const config = join(agent, 'mcp.json')
  await writeFile(
    config,
    JSON.stringify({ mcpServers: { fast: { command: 'fake' }, slow: { command: 'fake' } } }),
  )
  const harness = await launch({ agentDir: agent, env: { PHOSPHOR_E2E_MCP_DELAY: '8000' } })
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'MCP Connectors', exact: true }).click()
    const fast = page.getByTestId('connector-fast')
    const slow = page.getByTestId('connector-slow')
    await expect(fast.getByText('Up · 3 tools')).toBeVisible()
    await expect(slow.getByRole('button', { name: 'Testing…', exact: true })).toBeVisible()
    await expect(slow.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0)
    await fast.getByRole('button', { name: 'Tools (3)', exact: true }).click()
    await fast.getByPlaceholder('Search 3 tools by name or description').fill('responder')
    await expect(fast.getByText('Find incidents and on-call responders.')).toBeVisible()
    await expect(fast.getByText('Details for get_issue.')).toHaveCount(0)
    await page.getByRole('button', { name: 'Cancel checks', exact: true }).click()
    await expect(slow.getByText('Check cancelled.')).toBeVisible()
    await writeFile(
      config,
      JSON.stringify({ mcpServers: { fast: { command: 'fake' }, added: { command: 'fake' } } }),
    )
    await page.getByRole('button', { name: 'Refresh & test all', exact: true }).click()
    await expect(page.getByTestId('connector-added').getByText('Up · 3 tools')).toBeVisible()
    await expect(page.getByTestId('connector-slow')).toHaveCount(0)
    await expect(fast.getByRole('button', { name: 'Tools (3)', exact: true })).toBeVisible()
  } finally {
    await shutdown(harness)
  }
})

test('Connectors: native lane inspection and reconnect do not create model turns', async () => {
  const agent = privateAgentDir()
  const scratch = await scratchDir('phosphor-mcp-lane-')
  const log = join(scratch, 'commands.jsonl')
  await writeFile(
    join(agent, 'mcp.json'),
    JSON.stringify({ mcpServers: { local: { command: 'fake' } } }),
  )
  const harness = await launch({ agentDir: agent, env: { PHOSPHOR_E2E_COMMAND_LOG: log } })
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('hello')
    await page.getByRole('button', { name: 'Start session', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText('Done: hello.ts updated.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'MCP Connectors', exact: true }).click()
    const row = page.getByTestId('connector-local')
    await row.getByText('Selected lane · connected · 3 tools', { exact: true }).click()
    await row.getByRole('button', { name: 'Reconnect in lane', exact: true }).click()
    await expect(row.getByRole('button', { name: 'Reconnect in lane', exact: true })).toBeEnabled()
    await expect(
      row.getByText('Selected lane · connected · 3 tools', { exact: true }),
    ).toBeVisible()
    await expect(page.getByText(/"requestId":/)).toHaveCount(0)
    const commands = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; message?: string })
    expect(
      commands.some((command) =>
        command.message?.startsWith('/mcp reconnect local --json --request '),
      ),
    ).toBe(true)
    expect(
      commands
        .filter((command) => command.type === 'prompt' && !command.message?.startsWith('/'))
        .map((command) => command.message),
    ).toEqual(['hello'])
  } finally {
    await shutdown(harness)
  }
})
