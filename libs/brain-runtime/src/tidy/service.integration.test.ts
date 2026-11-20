import { CallTracer } from '../call-trace'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { openBrainStore } from '@phosphor/memory-engine/store'
import { createBrainService } from '../service'
import { approveRead, realService } from './__fixtures__/real-service'

it('approves, sweeps, checks without applying, then merges and undoes with a real store', async () => {
  const s = await realService()
  const status = await approveRead(s.store, s.service, s.options)
  expect(status.counts).toEqual({ memories: 4, entities: 2 })
  expect(status.tidy).toMatchObject({ open: 7, automaticFolds: 1, running: false })
  const changes = await s.service.api.tidyChanges(50)
  expect(changes.items).toMatchObject([{ kind: 'fold', who: 'automatic', undoable: true }])
  const before = await s.service.api.tidy(null, null, 50)
  expect(before.counts).toEqual({ same_entity: 1, same_memory: 6, conflict: 0, flagged: 0 })

  await s.service.api.tidyRun()
  await vi.waitFor(() => expect(s.store.readRun()?.state).toBe('done'))
  expect(s.call).toHaveBeenCalledOnce()
  const checked = await s.service.api.tidy(null, null, 50)
  expect(checked.coverage).toMatchObject({ phase: 'done', limitedChecks: 0 })
  expect(checked.run).toMatchObject({ checked: 7, total: 7, state: 'done' })
  expect(checked.counts).toEqual({ same_entity: 1, same_memory: 0, conflict: 1, flagged: 0 })
  expect((await s.service.api.status()).counts).toEqual(status.counts)
  expect((await s.service.api.tidyChanges(50)).items).toEqual(changes.items)
  const same = checked.items.find((item) => item.kind === 'same_entity')!
  expect(same.verdict?.kind).toBe('same')
  expect(checked.items.find((item) => item.kind === 'conflict')?.verdict?.kind).toBe('conflict')
  for (const item of before.items.filter((item) => !checked.items.some((v) => v.id === item.id))) {
    expect((await s.service.api.tidySuggestion(item.id))?.suggestion).toMatchObject({
      state: 'cleared',
      verdict: { kind: 'different' },
    })
  }
  const survivor = same.subjects.find((subject) => subject.label === 'Rina')!
  const merged = await s.service.api.tidyApply(
    same.id,
    { kind: 'merge', survivorId: survivor.id },
    checked.revision,
  )
  expect(merged.counts.entities).toBe(1)
  expect(merged.operationId).toBeTruthy()
  const undone = await s.service.api.tidyUndo(merged.operationId!, merged.revision)
  expect(undone.counts.entities).toBe(2)
  await s.service.api.tidyRun()
  await vi.waitFor(() => expect(s.store.readRun()?.state).toBe('done'))
  expect((await s.service.api.tidy(null, null, 50)).counts.same_entity).toBe(0)
  expect(s.call).toHaveBeenCalledOnce()
})

it('refuses a stale dispute with a plain sentence, then journals it at the current revision', async () => {
  const s = await realService()
  await approveRead(s.store, s.service, s.options)
  const page = await s.service.api.tidy('same_memory', null, 50)
  const details = await Promise.all(page.items.map((i) => s.service.api.tidySuggestion(i.id)))
  const pair = page.items[details.findIndex((d) => d?.allowed.includes('dispute'))]!
  const before = await s.service.api.tidyChanges(50)
  await s.service.api.tidyDismiss(page.items.find((item) => item.id !== pair.id)!.id, page.revision)
  await expect(
    s.service.api.tidyApply(pair.id, { kind: 'dispute' }, page.revision),
  ).rejects.toThrow('Brain changed; refresh Tidy and try again.')
  expect(await s.service.api.tidyChanges(50)).toMatchObject({ items: before.items })
  const fresh = (await s.service.api.status()).revision
  const disputed = await s.service.api.tidyApply(pair.id, { kind: 'dispute' }, fresh)
  expect(disputed.operationId).toBeTruthy()
  expect((await s.service.api.tidyChanges(50)).items[0]).toMatchObject({
    id: disputed.operationId,
    kind: 'dispute',
  })
})

it('files lane flags through the agent entry and refuses a second, a sixth and a forgotten memory', async () => {
  const s = await realService()
  await approveRead(
    s.store,
    s.service,
    s.options,
    Array.from({ length: 6 }, (_, i) => `Harbor keeps Ledger policy ${i}.`),
  )
  const recall = await s.service.agent('search', { query: 'Harbor', limit: 20 })
  expect(recall.hits).toHaveLength(6)
  const ids = recall.hits.map((hit) => hit.memory.id)
  const flag = (memoryId: string) =>
    s.service.agent('flag', {
      memoryId,
      sessionId: 'kestrel-lane',
      title: 'Kestrel review',
      problem: 'wrong',
      reason: 'The lane verified a different Ledger policy.',
    })
  expect((await flag(ids[0]!)).status).toBe('filed')
  expect((await flag(ids[0]!)).status).toBe('already_flagged')
  for (const id of ids.slice(1, 5)) expect((await flag(id)).status).toBe('filed')
  expect((await flag(ids[5]!)).status).toBe('limit')
  const flags = await s.service.api.tidy('flagged', null, 20)
  expect(flags.items).toHaveLength(5)
  expect(flags.items[0]?.flag).toMatchObject({ sessionId: 'kestrel-lane', title: 'Kestrel review' })
  await s.service.api.forget(ids[0]!)
  expect((await flag(ids[0]!)).status).toBe('unavailable')
})

function tidyText(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'tidy_%'")
      .all()
    return JSON.stringify(
      tables.map(({ name }) => db.prepare(`SELECT * FROM ${String(name)}`).all()),
    )
  } finally {
    db.close()
  }
}

it('Forget removes a suggested memory and its before-images from every Tidy table', async () => {
  const s = await realService()
  await approveRead(s.store, s.service, s.options)
  const path = join(s.directory, 'brain.sqlite')
  const sentence = 'Rina leads Ledger.'
  const memory = (await s.service.api.find(sentence, 20)).memories.find(
    (m) => m.summary === sentence,
  )!
  expect(memory).toBeDefined()
  expect(tidyText(path)).toContain(sentence)
  expect(
    (await s.service.api.tidy(null, null, 50)).items.some((item) =>
      item.subjects.some((subject) => subject.id === memory.id),
    ),
  ).toBe(true)
  expect((await s.service.api.tidyChanges(50)).items[0]?.kind).toBe('fold')
  await s.service.api.forget(memory.id)
  expect(tidyText(path)).not.toContain(sentence)
  expect(
    (await s.service.api.tidy(null, null, 50)).items.every((item) =>
      item.subjects.every((subject) => subject.id !== memory.id),
    ),
  ).toBe(true)
  await expect(
    s.service.api.tidyUndo((await s.service.api.tidyChanges(50)).items[0]!.id, s.store.revision()),
  ).rejects.toThrow()
  await expect(s.service.api.memory(memory.id)).rejects.toThrow()
})

it('reopens an in-flight persisted run as interrupted without starting any model calls', async () => {
  const s = await realService()
  await approveRead(s.store, s.service, s.options)
  const crashDirectory = join(s.directory, 'crash-image')
  await mkdir(crashDirectory)
  const crashPath = join(crashDirectory, 'brain.sqlite')
  s.call.mockImplementationOnce(async ({ signal }) => {
    const db = new DatabaseSync(join(s.directory, 'brain.sqlite'))
    // Snapshot a genuine checking checkpoint, before graceful shutdown cancels the original.
    db.exec(`VACUUM INTO '${crashPath.replaceAll("'", "''")}'`)
    db.close()
    return new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }),
    )
  })
  await s.service.api.tidyRun()
  await vi.waitFor(() => expect(s.call).toHaveBeenCalledOnce())
  await s.service.dispose()
  const persisted = openBrainStore({ path: crashPath, Database: DatabaseSync })
  expect(persisted.readRun()?.state).toBe('checking')
  persisted.close()
  const reopened = await createBrainService({
    ...s.options,
    directory: crashDirectory,
    openStore: (path) => openBrainStore({ path, Database: DatabaseSync }),
  })
  try {
    const page = await reopened.api.tidy(null, null, 50)
    expect(page.run).toMatchObject({
      state: 'interrupted',
      checked: 0,
      total: 7,
      error: expect.stringContaining('interrupted'),
    })
    expect((await reopened.api.status()).tidy.running).toBe(false)
    expect(page.items.every((item) => item.verdict === null)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(s.call).toHaveBeenCalledOnce()
  } finally {
    await reopened.dispose()
  }
})

it.each(['next batch', 'transport retry'])(
  'does not send forgotten text in the %s',
  async (mode) => {
    const s = await realService()
    await approveRead(
      s.store,
      s.service,
      s.options,
      Array.from({ length: 7 }, (_, i) => `Harbor retains Ledger policy ${i}.`),
    )
    const pairs = s.store.pendingPairs(40)
    const subject = pairs
      .slice(mode === 'next batch' ? 8 : 0, mode === 'next batch' ? 16 : 8)
      .flatMap((pair) => pair.subjects)
      .find((subject) => subject.type === 'memory')!
    expect(subject.type).toBe('memory')
    if (subject.type !== 'memory') throw new Error('Expected a memory pair')
    const normal = s.call.getMockImplementation()!
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    s.options.retryDelay = async () => {}
    s.call.mockImplementationOnce(async (input) => {
      await held
      if (mode === 'transport retry') {
        const trace = new CallTracer()
        trace.finish('exit')
        input.onTrace?.(trace.trace)
        throw new Error('Fake transport exit')
      }
      return normal(input)
    })
    await s.service.api.tidyRun()
    await vi.waitFor(() => expect(s.call).toHaveBeenCalledOnce())
    await s.service.api.forget(subject.id)
    release()
    await vi.waitFor(() => expect(s.store.readRun()?.state).toBe('done'))
    expect(s.call.mock.calls.length).toBeGreaterThan(1)
    const laterPrompts = s.call.mock.calls
      .slice(1)
      .map(([input]) => input.prompt)
      .join('\n')
    expect(laterPrompts).not.toContain(subject.sentence)
  },
)
