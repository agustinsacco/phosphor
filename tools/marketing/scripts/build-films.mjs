/* global console, process, Buffer */
// One entry for the site's films: check the sources, render them, cut the posters and verify
// the files that ship. Everything runs locally; the Hyperframes CLI is the pinned devDependency
// and is always started with telemetry, update checks and auto-install switched off.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { manifest, platesDirectory, repo, root, syncAssets } from './sync-assets.mjs'

export const mediaDirectory = join(repo, 'apps/site/public/media')
export const recordPath = join(root, 'media.json')
const hyperframes = join(root, 'node_modules/.bin/hyperframes')
const quiet = {
  HYPERFRAMES_NO_TELEMETRY: '1',
  DO_NOT_TRACK: '1',
  HYPERFRAMES_NO_UPDATE_CHECK: '1',
  HYPERFRAMES_NO_AUTO_INSTALL: '1',
}
// The site plays these silent by contract, so the one craft warning about sound is expected.
const expectedWarnings = new Set(['film_silent'])

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...quiet },
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  return result
}

function must(command, args, cwd) {
  const result = run(command, args, cwd)
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  return result.stdout
}

const filmDirectory = (film) => join(root, 'films', film.id)
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** `hyperframes check`: lint, runtime, layout, contrast and craft, in one browser pass. */
export function checkFilm(film) {
  const result = run(hyperframes, ['check', '--json'], filmDirectory(film))
  const report = JSON.parse(result.stdout)
  const findings = ['lint', 'runtime', 'layout', 'motion', 'contrast', 'craft', 'audio']
    .flatMap((section) => report[section]?.findings ?? [])
    .filter((finding) => finding.severity === 'error' || finding.severity === 'warning')
    .filter((finding) => !expectedWarnings.has(finding.code))
  if (report.browserSkipped) throw new Error(`${film.id}: the browser audit did not run`)
  if (!report.ok || findings.length) {
    const lines = findings.map(
      (finding) => `  ${finding.severity} ${finding.code}: ${finding.message}`,
    )
    throw new Error(`${film.id}: check failed\n${lines.join('\n')}`)
  }
  return report.contrast.checked
}

function renderFilm(film) {
  const output = join(mediaDirectory, `${film.id}.mp4`)
  const args = ['render', '--quality', 'delivery', '--crf', String(manifest.crf)]
  args.push('--keyframe-interval', '2', '--fps', String(manifest.fps), '--output', output)
  must(hyperframes, args, filmDirectory(film))
  const poster = join(mediaDirectory, `${film.id}.webp`)
  const still = ['-v', 'error', '-y', '-ss', String(film.posterAt), '-i', output, '-frames:v', '1']
  must('ffmpeg', [...still, '-c:v', 'libwebp', '-quality', '88', poster])
}

function probe(file) {
  const fields = 'stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate:format=duration'
  return JSON.parse(must('ffprobe', ['-v', 'error', '-show_entries', fields, '-of', 'json', file]))
}

/** Top-level MP4 boxes in file order; `moov` before `mdat` lets a browser seek without the tail. */
function topLevelBoxes(file) {
  const handle = openSync(file, 'r')
  const size = statSync(file).size
  const header = Buffer.alloc(16)
  const boxes = []
  try {
    for (let offset = 0; offset < size;) {
      if (readSync(handle, header, 0, 16, offset) < 8) break
      const short = header.readUInt32BE(0)
      const length = short === 1 ? Number(header.readBigUInt64BE(8)) : short
      boxes.push(header.toString('latin1', 4, 8))
      if (length < 8) break
      offset += length
    }
  } finally {
    closeSync(handle)
  }
  return boxes
}

/** What a shipped film is, measured from the file rather than from what the render was asked. */
export function describeFilm(film) {
  const video = join(mediaDirectory, `${film.id}.mp4`)
  const poster = join(mediaDirectory, `${film.id}.webp`)
  const { streams, format } = probe(video)
  const picture = streams.find((stream) => stream.codec_type === 'video')
  const still = probe(poster).streams[0]
  const boxes = topLevelBoxes(video)
  return {
    id: film.id,
    video: { bytes: statSync(video).size, sha256: sha256(video) },
    poster: { bytes: statSync(poster).size, sha256: sha256(poster) },
    codec: picture.codec_name,
    pixelFormat: picture.pix_fmt,
    width: picture.width,
    height: picture.height,
    frameRate: picture.r_frame_rate,
    seconds: Number(Number(format.duration).toFixed(3)),
    audioStreams: streams.filter((stream) => stream.codec_type === 'audio').length,
    seekableFromStart: boxes.indexOf('moov') > -1 && boxes.indexOf('moov') < boxes.indexOf('mdat'),
    posterWidth: still.width,
    posterHeight: still.height,
  }
}

/** The delivery contract the site relies on; returns the measured description when it holds. */
export function verifyFilm(film) {
  const found = describeFilm(film)
  const expected = {
    codec: 'h264',
    pixelFormat: 'yuv420p',
    width: manifest.width,
    height: manifest.height,
    frameRate: `${manifest.fps}/1`,
    audioStreams: 0,
    seekableFromStart: true,
    posterWidth: manifest.width,
    posterHeight: manifest.height,
  }
  const wrong = Object.entries(expected)
    .filter(([key, value]) => found[key] !== value)
    .map(([key, value]) => `${key} is ${found[key]}, expected ${value}`)
  if (Math.abs(found.seconds - film.duration) > 0.05)
    wrong.push(`runs ${found.seconds}s, expected ${film.duration}s`)
  if (wrong.length) throw new Error(`${film.id}: ${wrong.join('; ')}`)
  return found
}

function record(films) {
  const plates = {}
  for (const name of [...new Set(manifest.films.flatMap((film) => film.plates))].sort())
    plates[`${name}.png`] = sha256(join(platesDirectory(), `${name}.png`))
  const version = must(hyperframes, ['--version']).trim()
  const body = { hyperframes: version, crf: manifest.crf, films, plates }
  writeFileSync(recordPath, `${JSON.stringify(body, null, 2)}\n`)
}

function selectFilms(ids) {
  const unknown = ids.filter((id) => !manifest.films.some((film) => film.id === id))
  if (unknown.length) throw new Error(`Unknown film: ${unknown.join(', ')}`)
  return ids.length ? manifest.films.filter((film) => ids.includes(film.id)) : manifest.films
}

function main([command, ...ids]) {
  const films = selectFilms(ids)
  if (command === 'verify') {
    for (const film of films) console.log(JSON.stringify(verifyFilm(film)))
    return
  }
  if (command !== 'check' && command !== 'build')
    throw new Error('Usage: node scripts/build-films.mjs <check|build|verify> [film-id...]')
  console.log(`Plates: ${syncAssets()}`)
  for (const film of films)
    console.log(`${film.id}: check passed (${checkFilm(film)} contrast samples)`)
  if (command === 'check') return
  mkdirSync(mediaDirectory, { recursive: true })
  for (const film of films) {
    renderFilm(film)
    console.log(`${film.id}: rendered`)
  }
  // The record always covers every film, so a partial rebuild cannot leave stale hashes behind.
  record(manifest.films.map(verifyFilm))
  console.log(`Recorded ${recordPath}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
