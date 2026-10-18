/** Preview and confirm user-selected Markdown and guarded skill archives. */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  parseSkillFrontmatter,
  skillFrontmatterWarnings,
  validateSkillName,
  type SkillImportPreview,
  type SkillScope,
} from '@shared/skills'
import { readZipEntries, type ZipEntry } from '../zip'
import { MAX_ARCHIVE_BYTES, registerKnownSkillDir, skillRoots, within } from './bundle'

/** Inspect a user-chosen `.md` / `.zip` / `.skill` without writing anything. */
export async function previewSkillImport(sourcePath: string): Promise<SkillImportPreview> {
  if (/\.md$/i.test(sourcePath)) {
    const text = await readFile(sourcePath, 'utf8')
    const { attrs } = parseSkillFrontmatter(text)
    const warnings = skillFrontmatterWarnings(attrs)
    return {
      sourcePath,
      kind: 'md',
      name: attrs['name'] || null,
      description: attrs['description'] || null,
      files: [{ path: 'SKILL.md', size: Buffer.byteLength(text) }],
      skillMd: text,
      warnings,
    }
  }
  if (!/\.(zip|skill)$/i.test(sourcePath)) throw new Error('expected a .md, .zip or .skill file')
  const info = await stat(sourcePath)
  if (info.size > MAX_ARCHIVE_BYTES) throw new Error('archive exceeds the size cap')
  const bundle = archiveBundle(readZipEntries(await readFile(sourcePath)))
  const skillMd = bundle.find((file) => file.rel === 'SKILL.md')
  if (!skillMd) throw new Error('the archive has no SKILL.md')
  const text = skillMd.data.toString('utf8')
  const { attrs } = parseSkillFrontmatter(text)
  return {
    sourcePath,
    kind: 'zip',
    name: attrs['name'] || null,
    description: attrs['description'] || null,
    files: bundle.map((file) => ({ path: file.rel, size: file.data.length })),
    skillMd: text,
    warnings: skillFrontmatterWarnings(attrs),
  }
}

/**
 * Normalize archive entries to bundle-relative paths: SKILL.md may sit at the
 * archive root or inside a single top-level folder (how exports and GitHub
 * "download zip" both package it).
 */
function archiveBundle(entries: ZipEntry[]): Array<{ rel: string; data: Buffer }> {
  if (entries.some((entry) => entry.path === 'SKILL.md')) {
    return entries.map((entry) => ({ rel: entry.path, data: entry.data }))
  }
  const tops = new Set(entries.map((entry) => entry.path.split('/')[0]))
  if (tops.size === 1) {
    const prefix = `${[...tops][0]}/`
    return entries
      .filter((entry) => entry.path.length > prefix.length)
      .map((entry) => ({ rel: entry.path.slice(prefix.length), data: entry.data }))
  }
  return entries.map((entry) => ({ rel: entry.path, data: entry.data }))
}

export interface ConfirmImportOptions {
  sourcePath: string
  scope: SkillScope
  workspacePath?: string
  /** Overrides the frontmatter name (required when it is missing/invalid). */
  overrideName?: string
}

export async function confirmSkillImport(options: ConfirmImportOptions): Promise<{ dir: string }> {
  const preview = await previewSkillImport(options.sourcePath)
  const name = options.overrideName ?? preview.name ?? ''
  const nameError = validateSkillName(name)
  if (nameError) throw new Error(nameError)
  const roots = skillRoots(options.workspacePath)
  const root = options.scope === 'project' ? roots.projectRoot : roots.userRoot
  if (!root) throw new Error('no workspace open for a project skill')
  const dir = join(root, name)
  if (existsSync(dir)) throw new Error(`a skill named "${name}" already exists there`)

  if (preview.kind === 'md') {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), preview.skillMd, 'utf8')
  } else {
    const bundle = archiveBundle(readZipEntries(await readFile(options.sourcePath)))
    for (const file of bundle) {
      const target = resolve(dir, file.rel)
      if (!within(dir, target)) throw new Error(`entry escapes the bundle: ${file.rel}`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.data)
    }
  }
  registerKnownSkillDir(dir)
  return { dir }
}
