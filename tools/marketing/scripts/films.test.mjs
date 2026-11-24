// Run with `npm test` in tools/marketing (node:test, no install needed for the source checks).
// The source checks hold the films to what the site promises about them; the media checks hold
// the committed files to the record written by the build.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { mediaDirectory, recordPath } from './build-films.mjs'
import { manifest, platesDirectory, root } from './sync-assets.mjs'

const slate = 'Product demo · fictional data'
const filmDirectory = (film) => join(root, 'films', film.id)
const read = (file) => readFileSync(file, 'utf8')
const attribute = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1]

function hosts(film) {
  const page = read(join(filmDirectory(film), 'index.html'))
  const tags = page.match(/<div[^>]*data-composition-src="[^"]*"[^>]*>/g) ?? []
  const main = page.match(/<div[^>]*data-composition-id="main"[^>]*>/)[0]
  return {
    seconds: Number(attribute(main, 'data-duration')),
    scenes: tags.map((tag) => ({
      id: attribute(tag, 'data-composition-id'),
      file: attribute(tag, 'data-composition-src'),
      start: Number(attribute(tag, 'data-start')),
      seconds: Number(attribute(tag, 'data-duration')),
    })),
  }
}

for (const film of manifest.films) {
  test(`${film.id}: scenes tile the film with no gap or overlap`, () => {
    const { seconds, scenes } = hosts(film)
    let clock = 0
    for (const scene of scenes) {
      assert.ok(Math.abs(scene.start - clock) < 1e-6, `${scene.id} starts at ${scene.start}`)
      clock += scene.seconds
    }
    assert.ok(Math.abs(clock - seconds) < 1e-6, 'scene slots add up to the root duration')
    assert.equal(seconds, film.duration, 'films.json states the same length')
  })

  test(`${film.id}: every scene that shows the product says the data is fictional`, () => {
    for (const scene of hosts(film).scenes) {
      const source = read(join(filmDirectory(film), scene.file))
      assert.ok(
        source.includes(`data-composition-id="${scene.id}"`),
        `${scene.file} is ${scene.id}`,
      )
      assert.ok(source.includes(`window.__timelines['${scene.id}']`), `${scene.id} registers`)
      if (source.includes('assets/shots/')) assert.ok(source.includes(slate), `${scene.id} slate`)
    }
  })

  test(`${film.id}: every listed capture is available to render`, () => {
    for (const plate of film.plates)
      assert.ok(existsSync(join(platesDirectory(), `${plate}.png`)), `missing capture: ${plate}`)
  })

  test(`${film.id}: uses exactly the captures films.json lists, and nothing remote`, () => {
    const directory = join(filmDirectory(film), 'compositions')
    const sources = readdirSync(directory).map((file) => read(join(directory, file)))
    const used = new Set(sources.join('\n').match(/(?<=assets\/shots\/)[\w-]+(?=\.png)/g))
    assert.deepEqual([...used].sort(), [...film.plates].sort())
    const page = read(join(filmDirectory(film), 'index.html'))
    const remote = [page, ...sources].join('\n').match(/https?:\/\/[^"'\s)]+/g) ?? []
    // Hyperframes ships this exact GSAP build and serves it locally at render time.
    assert.deepEqual(remote, ['https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js'])
  })

  test(`${film.id}: sources stay within the repository's size rule`, () => {
    const directory = join(filmDirectory(film), 'compositions')
    for (const file of readdirSync(directory))
      assert.ok(read(join(directory, file)).split('\n').length <= 400, file)
  })
}

test('shipped media matches the build record', { skip: !existsSync(recordPath) }, () => {
  const record = JSON.parse(read(recordPath))
  assert.deepEqual(
    record.films.map((film) => film.id).sort(),
    manifest.films.map((f) => f.id).sort(),
  )
  for (const film of record.films) {
    assert.equal(film.codec, 'h264')
    assert.equal(film.pixelFormat, 'yuv420p')
    assert.equal(film.audioStreams, 0)
    assert.equal(film.seekableFromStart, true)
    assert.deepEqual([film.width, film.height], [manifest.width, manifest.height])
    for (const [kind, extension] of [
      ['video', 'mp4'],
      ['poster', 'webp'],
    ]) {
      const bytes = readFileSync(join(mediaDirectory, `${film.id}.${extension}`))
      assert.equal(bytes.length, film[kind].bytes, `${film.id}.${extension} bytes`)
      const hash = createHash('sha256').update(bytes).digest('hex')
      assert.equal(hash, film[kind].sha256, `${film.id}.${extension} sha256`)
    }
  }
})
