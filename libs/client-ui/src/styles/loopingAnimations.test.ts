import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

// Looping motion keeps the renderer and GPU drawing every frame, so each one
// must stop while the window is in the background (app/windowMotion.ts).
const src = join(import.meta.dirname, '..')
const sheets = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.css'))
  .map((file) => ({ file, lines: readFileSync(join(src, file), 'utf8').split('\n') }))

it('pauses every infinite animation with the window', () => {
  const missing: string[] = []
  let loops = 0
  for (const { file, lines } of sheets)
    lines.forEach((line, i) => {
      if (!/^\s*animation:[^;]*\binfinite\b/.test(line)) return
      loops++
      // After the shorthand, which would otherwise reset it to running.
      if (!/^\s*animation-play-state: var\(--px-loop-state\);/.test(lines[i + 1] ?? ''))
        missing.push(`${relative(src, join(src, file))}:${i + 1}`)
    })
  expect(loops).toBeGreaterThan(0)
  expect(missing).toEqual([])
})

it('defines the loop state and pauses it on an inactive window', () => {
  const css = readFileSync(join(src, 'styles/index.css'), 'utf8')
  expect(css).toMatch(/--px-loop-state: running;/)
  expect(css).toMatch(/:root\[data-window-inactive\] \{\s*--px-loop-state: paused;/)
  expect(css).toMatch(/\.animate-pulse,[\s\S]*?animation-play-state: var\(--px-loop-state\);/)
})

it('animates no background-position: a moving background repaints every frame', () => {
  const offenders: string[] = []
  for (const { file, lines } of sheets) {
    let depth = 0
    let keyframesAt: number | undefined
    lines.forEach((line, i) => {
      if (keyframesAt === undefined && /@keyframes/.test(line)) keyframesAt = depth
      if (keyframesAt !== undefined && /^\s*background-position:/.test(line))
        offenders.push(`${file}:${i + 1}`)
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
      if (keyframesAt !== undefined && depth <= keyframesAt) keyframesAt = undefined
    })
  }
  expect(offenders).toEqual([])
})
