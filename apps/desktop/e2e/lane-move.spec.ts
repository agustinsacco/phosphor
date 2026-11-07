import { test, expect } from '@playwright/test'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, shutdown, privateAgentDir } from './fixtures/local-app'
import { scratchDir } from './fixtures/scratch'

const id = '01a0272a-7be5-76ed-b420-36b363924622'
const fileName = `2026-08-22T22-56-30-785Z_${id}.jsonl`

const sessionDir = (agent: string, cwd: string) =>
  join(agent, 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)

async function seedLane() {
  const workspace = await realpath(await scratchDir('phosphor-e2e-move-'))
  const target = join(workspace, 'another-folder')
  const profile = join(workspace, 'profile')
  const agent = privateAgentDir()
  const source = join(sessionDir(agent, workspace), fileName)
  await mkdir(target)
  await mkdir(profile)
  await mkdir(sessionDir(agent, workspace), { recursive: true })
  const original =
    [
      { type: 'session', version: 3, id, cwd: workspace, timestamp: '2026-08-22T22:56:30Z' },
      {
        type: 'session_info',
        id: 'name0001',
        parentId: null,
        name: 'Research to keep',
        timestamp: '2026-08-22T22:56:31Z',
      },
      {
        type: 'message',
        id: 'ask00001',
        parentId: 'name0001',
        timestamp: '2026-08-22T22:56:32Z',
        message: { role: 'user', content: 'Keep the conversation, not this folder’s files.' },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n'
  await writeFile(source, original)
  await writeFile(
    join(profile, 'config.json'),
    JSON.stringify({
      lastWorkspacePath: workspace,
      recentWorkspaces: [
        { path: workspace, name: 'Source' },
        { path: target, name: 'Destination' },
      ],
      pinnedSessions: [source],
      laneMarkers: { [source]: '🔬' },
    }),
  )
  return { workspace, target, profile, agent, source, original }
}

test('Move to… copies a stopped no-git lane to another folder without touching the source', async () => {
  const { workspace, target, profile, agent, source, original } = await seedLane()
  const h = await launch({ workspace, agentDir: agent, userDataDir: profile })
  try {
    const row = h.page.getByTestId('session-row').filter({ hasText: 'Research to keep' }).first()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.click({ button: 'right' })
    await h.page.getByText('Move to…', { exact: true }).click()
    await h.page
      .getByRole('combobox', { name: 'Workspace', exact: true })
      .selectOption(`local:${target}`)
    const move = h.page.getByRole('button', { name: 'Move', exact: true })
    await h.page
      .getByRole('checkbox', { name: /I understand this uses the target/ })
      .check({ timeout: 30_000 })
    await expect(move).toBeEnabled({ timeout: 30_000 })
    await expect(
      h.page.getByText('The conversation moves into this folder.', { exact: false }),
    ).toBeVisible()
    await move.click()
    await expect(h.page.getByText(/Moved to This Mac · Destination/)).toBeVisible({
      timeout: 30_000,
    })
    const files = await readdir(sessionDir(agent, target))
    const copy = join(
      sessionDir(agent, target),
      files.find((name) => name.endsWith('.jsonl'))!,
    )
    const copied = (await readFile(copy, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(copied[0]).toMatchObject({ cwd: target })
    expect(copied[0].id).not.toBe(id)
    expect(copied[1].name).toBe('Research to keep')
    expect(copied.at(-1)).toMatchObject({
      type: 'custom_message',
      customType: 'phosphor-lane-moved',
    })
    expect(await readFile(source, 'utf8')).toBe(original)
    await expect
      .poll(async () => {
        const prefs = JSON.parse(await readFile(join(profile, 'config.json'), 'utf8'))
        return { pinned: prefs.pinnedSessions.includes(copy), marker: prefs.laneMarkers[copy] }
      })
      .toEqual({ pinned: true, marker: '🔬' })
    await h.page.getByRole('button', { name: 'Done', exact: true }).click()
  } finally {
    await shutdown(h)
  }
})
