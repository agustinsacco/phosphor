#!/usr/bin/env node
/** RL-01 only plans. JSON on stdout is FD-05's manifest plus hashed edits/reports. */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listTestFiles, loadProjectRoots } from './select-unit-tests.mjs'
import { buildPlan } from './relocation/plan.mjs'

export function main(args = process.argv.slice(2)) {
  if (args.includes('--apply') || args.includes('--verify'))
    throw new Error('--apply/--verify not implemented in RL-01')
  if (args.some((arg) => arg !== '--plan') || args.length > 1)
    throw new Error('Usage: node tools/scripts/relocate-tests.mjs [--plan]')
  const root = process.cwd()
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 32 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  const plan = buildPlan({
    root,
    files,
    tests: listTestFiles(root),
    projects: loadProjectRoots(root),
  })
  console.log(JSON.stringify(plan, null, 2))
  if (plan.collisions.length) process.exitCode = 1
  return plan
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
