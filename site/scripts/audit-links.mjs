// Live external checks are explicit, separate from deterministic CI browser tests.
/* global DOMParser, URL */
import { readdir, readFile } from 'node:fs/promises'
import { chromium, request } from '@playwright/test'
import GithubSlugger from 'github-slugger'

const dist = new URL('../dist/', import.meta.url)
async function htmlFiles(dir) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
    if (entry.isDirectory()) files.push(...(await htmlFiles(path)))
    else if (entry.name.endsWith('.html')) files.push(path)
  }
  return files
}
const browser = await chromium.launch()
const http = await request.newContext({ timeout: 30_000, userAgent: 'PhosphorSiteLinkAudit/1.0' })
const failures = []
try {
  const parser = await browser.newPage()
  const links = new Set()
  for (const file of await htmlFiles(dist)) {
    const html = await readFile(file, 'utf8')
    const hrefs = await parser.evaluate(
      (html) =>
        [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('a[href]')].map(
          (a) => a.getAttribute('href'),
        ),
      html,
    )
    for (const href of hrefs) if (/^https?:\/\//.test(href)) links.add(href)
  }
  const cache = new Map()
  async function get(url) {
    if (!cache.has(url)) {
      const response = await http.get(url, { maxRetries: 1 })
      if (response.status() === 403) {
        // Some public vendor docs reject non-browser clients. Verify the actual
        // browser destination instead of silently treating a 403 as success.
        const probe = await browser.newPage()
        try {
          const opened = await probe.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
          if (!opened?.ok()) throw new Error(`HTTP ${opened?.status()} in browser at ${url}`)
          cache.set(url, { body: await probe.content(), url: probe.url(), browser: true })
        } finally {
          await probe.close()
        }
      } else {
        if (!response.ok()) throw new Error(`HTTP ${response.status()} at ${url}`)
        cache.set(url, { body: await response.text(), url: response.url() })
      }
    }
    return cache.get(url)
  }
  for (const href of [...links].sort()) {
    try {
      const target = new URL(href)
      const fragment = decodeURIComponent(target.hash.slice(1))
      target.hash = ''
      const result = await get(target.href)
      if (fragment) {
        const github =
          target.hostname === 'github.com' &&
          target.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+\.md)$/)
        let ids
        if (github) {
          const [, owner, repo, ref, path] = github
          const raw = await get(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`)
          const slugger = new GithubSlugger()
          let fence = false
          ids = raw.body.split('\n').flatMap((line) => {
            if (/^\s*(```|~~~)/.test(line)) {
              fence = !fence
              return []
            }
            if (fence || !/^#{1,6}\s/.test(line)) return []
            const heading = line
              .replace(/^#+\s+/, '')
              .replace(/\s+#+$/, '')
              .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
              .replace(/[*`]/g, '')
            return [slugger.slug(heading)]
          })
        } else {
          ids = await parser.evaluate(
            (html) =>
              [
                ...new DOMParser()
                  .parseFromString(html, 'text/html')
                  .querySelectorAll('[id], a[name]'),
              ].map((el) => el.id || el.getAttribute('name')),
            result.body,
          )
        }
        if (!ids.includes(fragment)) throw new Error(`Missing fragment #${fragment}`)
      }
      console.log(
        `PASS${result.browser ? ' (browser)' : ''} ${href}${result.url !== target.href ? ` → ${result.url}` : ''}`,
      )
    } catch (error) {
      failures.push(`${href}: ${error.message}`)
      console.error(`FAIL ${failures.at(-1)}`)
    }
  }
  console.log(`${links.size} external destinations checked; ${failures.length} failed.`)
} finally {
  await browser.close()
  await http.dispose()
}
if (failures.length) process.exitCode = 1
