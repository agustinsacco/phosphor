import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL } from 'node:url'
import sharp from 'sharp'
import { importShots } from './import-shots.mjs'

const root = new URL('../../../', import.meta.url)
test('every published capture has inventoried dimensions, bytes and honest provenance', async () => {
  const inventory = JSON.parse(
    await readFile(new URL('./fixtures/capture-inventory.json', import.meta.url), 'utf8'),
  )
  for (const directory of ['apps/site/src/assets/shots', 'docs/img']) {
    const names = (await readdir(new URL(directory + '/', root)))
      .filter((name) => /\.(png|webp)$/.test(name))
      .map((name) => directory + '/' + name)
      .sort()
    assert.deepEqual(
      inventory
        .filter((file) => file.path.startsWith(directory + '/'))
        .map((file) => file.path)
        .sort(),
      names,
    )
  }
  for (const file of inventory) {
    const bytes = await readFile(new URL(file.path, root))
    const metadata = await sharp(bytes).metadata()
    assert.equal(bytes.length, file.bytes, file.path)
    assert.equal(metadata.width, file.width, file.path)
    assert.equal(metadata.height, file.height, file.path)
    assert.equal(metadata.exif, undefined, file.path)
    assert.equal(metadata.xmp, undefined, file.path)
    assert.equal(metadata.icc, undefined, file.path)
    assert.match(file.provenance, /Product demo · fictional data/)
  }
  for (const name of [
    'brain-setup',
    'brain-graph',
    'brain-changes',
    'brain-ready',
    'brain-memory',
    'brain-extraction',
    'brain-queue',
    'brain-recall',
    'lane-pr',
    'slack-pill',
    'machines',
    'mobile',
    'notifications',
  ]) {
    assert.ok(
      inventory.some((f) => f.path === `apps/site/src/assets/shots/${name}.webp`),
      name,
    )
    assert.ok(
      inventory.some((f) => f.path === `docs/img/${name}.png`),
      name,
    )
  }
})
test('PNG contract and popup crops survive import without historical-size assumptions', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'phosphor-capture-test-'))
  try {
    const raw = join(temp, 'raw'),
      out = join(temp, 'out')
    await mkdir(raw)
    const png = await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#887744' },
    })
      .png()
      .toBuffer()
    const { writeFile } = await import('node:fs/promises')
    for (const name of ['ide-flex', 'models', 'models-picker', 'context', 'context-meter'])
      await writeFile(join(raw, `${name}.png`), png)
    await importShots(raw, out)
    assert.deepEqual(await readFile(join(out, 'ide-flex.png')), png)
    for (const name of ['models-picker', 'context-meter']) {
      const metadata = await sharp(join(out, `${name}.webp`)).metadata()
      assert.equal(metadata.width, 64)
      assert.equal(metadata.height, 48)
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('Brain demo links, evidence and dates form one coherent fictional world', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/brain-demo.json', import.meta.url), 'utf8'),
  )
  const ids = new Set(fixture.entities.map((entity) => entity.id))
  assert.equal(ids.size, 7)
  assert.equal(fixture.details.length, 7)
  for (const { memory, quotes, linkQuotes } of fixture.details) {
    assert.ok(memory.observedAt <= memory.recordedAt)
    assert.equal(memory.scope, '/demo/Harbor')
    assert.ok(quotes.some((quote) => quote.quote === memory.summary))
    for (const link of memory.links) {
      assert.ok(ids.has(link.subjectId))
      assert.ok(ids.has(link.objectId))
      assert.equal(link.memoryId, memory.id)
      assert.ok(linkQuotes[link.id].length)
    }
  }
  assert.match(fixture.provenance, /fictional/)
})

test('file API baseline and display diff describe the same token-refresh example', async () => {
  const file = JSON.parse(
    await readFile(new URL('./fixtures/auth-demo.json', import.meta.url), 'utf8'),
  )
  const messages = JSON.parse(
    await readFile(new URL('./fixtures/lane-demo.json', import.meta.url), 'utf8'),
  )
  assert.match(file.content, /pending \?\?=/)
  assert.doesNotMatch(file.baseline, /pending/)
  const result = messages.find((message) => message.toolCallId === 'edit-demo')
  assert.match(result.details.diff, /^\+\d+ /m)
  assert.match(result.details.diff, /^-\d+ /m)
  assert.match(result.details.patch, /^--- a\/src\/auth.ts/m)
})
