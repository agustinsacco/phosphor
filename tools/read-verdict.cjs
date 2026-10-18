#!/usr/bin/env node
// Extract the reviewer's verdict from its saved output. Accepts the fenced ```json block, or the
// plain trailer lines "VERDICT: pass|blocked" / "BLOCKING: <n>" (survives fence stripping).
// Always exits 0; missing or ambiguous -> blocked.
'use strict'
const fs = require('node:fs')
const file = process.argv[2]
let out = { verdict: 'blocked', blocking: 0, minor: 0, reason: '', file }
try {
  const text = fs.readFileSync(file, 'utf8')
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)].map((m) => m[1])
  let v = null
  for (const b of blocks.reverse()) { try { const j = JSON.parse(b); if (j && typeof j.verdict === 'string') { v = j; break } } catch { /* next */ } }
  if (v) {
    const findings = Array.isArray(v.findings) ? v.findings : []
    const blocking = findings.filter((f) => f && f.severity === 'blocking')
    out = { verdict: v.verdict === 'pass' && blocking.length === 0 ? 'pass' : 'blocked', blocking: blocking.length, minor: findings.length - blocking.length,
      reason: v.verdict === 'pass' && blocking.length ? 'verdict pass but blocking findings present' : '', file,
      top: blocking.slice(0, 5).map((f) => `${f.file || ''}:${f.line || ''} ${String(f.issue || '').slice(0, 300)}`) }
  } else {
    const vm = [...text.matchAll(/^\s*VERDICT:\s*(pass|blocked)\s*$/gim)].pop()
    const bm = [...text.matchAll(/^\s*BLOCKING:\s*(\d+)\s*$/gim)].pop()
    if (!vm) out.reason = 'no json verdict block and no "VERDICT: pass|blocked" trailer line'
    else {
      const n = bm ? Number(bm[1]) : null
      const pass = vm[1].toLowerCase() === 'pass' && n === 0
      out = { verdict: pass ? 'pass' : 'blocked', blocking: n ?? -1, minor: 0, file, reason: vm[1].toLowerCase() === 'pass' && n !== 0 ? 'pass trailer without BLOCKING: 0' : '' }
    }
  }
} catch (e) { out.reason = `cannot read review output: ${e.message}` }
process.stdout.write(JSON.stringify(out) + '\n')
