#!/usr/bin/env node
// Signed-in users can't SELECT a Task's crew pay (web repo,
// 20261016133000_task_pay_owner_manager): jobs.task_pay and
// recurring_series.task_pay. A jobs read that names it, or '*', or an insert
// or update that returns every column (a bare .select()), fails with 42501.
// The inspection screen's "this visit pays nothing" warning read it directly.
//
// Checks, on the source as it is (no build, nothing to mock):
//   1. Every .from('jobs') / .from('recurring_series') read and every embed of
//      either table in App.tsx and src/ leaves out task_pay and '*', filters
//      included, and no write returns every column.
//   2. Task pay comes from job_task_pay() through fetchJobTaskPay() only.
//   3. The inspection screen warns only about a pay it could read.
//
// Usage: node scripts/test-task-pay.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(repo, p), 'utf8')
let failures = 0
const ok = (name, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) failures++
  console.log(`${pass ? '✓' : '✗'}  ${name}${pass ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

const files = (dir) => readdirSync(join(repo, dir)).flatMap((f) => {
  const p = join(dir, f)
  if (statSync(join(repo, p)).isDirectory()) return files(p)
  return /\.(ts|tsx)$/.test(f) ? [p] : []
})
const SRC = ['App.tsx', ...files('src')].map((file) => ({ file, text: read(file) }))
const LIB = 'src/lib/jobTaskPay.ts'
const HELD = 'task_pay'

// "a, b, rel(x, y), alias:c" -> the top-level names (embeds dropped, aliases and casts stripped)
const topLevel = (list) => {
  const cols = []
  let depth = 0, cur = ''
  for (const ch of list + ',') {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      const t = cur.trim()
      if (t && !t.includes('(')) cols.push(t.replace(/^\w+:/, '').replace(/::\w+$/, ''))
      cur = ''
      continue
    }
    cur += ch
  }
  return cols
}
// a select list held in a string constant of the same file
const constant = (text, name) => {
  const m = new RegExp(`const ${name}\\s*=\\s*(['\`])([^'\`]*)\\1`).exec(text)
  return m ? m[2] : null
}
const resolve = (text, list) => {
  let good = true
  const out = list.replace(/\$\{(\w+)\}/g, (_, n) => {
    const v = constant(text, n)
    if (v === null) good = false
    return v ?? ''
  })
  return good ? out : null
}
// The call chain after .from(...): up to a comma, semicolon or closing bracket
// at its own depth, or a line break not followed by another .call.
const chainAfter = (text, at) => {
  let depth = 0, i = at
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch
      i++
      while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; i++ }
      i++
      continue
    }
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) { if (depth === 0) break; depth-- }
    else if (depth === 0 && (ch === ',' || ch === ';')) break
    else if (depth === 0 && ch === '\n' && !/^\s*\./.test(text.slice(i + 1, i + 200))) break
    i++
  }
  return text.slice(at, i)
}

// ── 1. every jobs and recurring_series read ──────────────────────────────────
let chains = 0, embeds = 0
const bad = []
for (const { file, text } of SRC) {
  if (file === LIB) continue
  for (const m of text.matchAll(/\.from\('(jobs|recurring_series)'\)/g)) {
    chains++
    const chain = chainAfter(text, m.index + m[0].length)
    const where = `${file}:${text.slice(0, m.index).split('\n').length} (${m[1]})`
    if (/\.select\(\s*\)/.test(chain)) bad.push(`${where}: a bare .select() returns every column, ${HELD} included`)
    const sel = /\.select\(\s*(?:(['`])([\s\S]*?)\1|([A-Za-z_]\w*))\s*[,)]/.exec(chain)
    if (/\.select\(\s*[^)\s]/.test(chain) && !sel) bad.push(`${where}: a select this test can't read`)
    if (sel) {
      const list = sel[3] ? constant(text, sel[3]) : resolve(text, sel[2])
      if (list === null) bad.push(`${where}: a select list this test can't resolve`)
      else {
        const cols = topLevel(list)
        if (cols.includes('*')) bad.push(`${where}: select('*')`)
        if (cols.includes(HELD)) bad.push(`${where}: selects ${HELD}`)
      }
    }
    for (const f of chain.matchAll(/\.(?:eq|neq|is|in|not|gt|gte|lt|lte|like|ilike|order|contains|or|filter|match)\(\s*'([^']*)'/g)) {
      if (new RegExp(`\\b${HELD}\\b`).test(f[1])) bad.push(`${where}: filters or sorts on ${HELD}`)
    }
  }
  for (const m of text.matchAll(/(?<![\w.'])(?:\w+:)?(jobs|recurring_series)(?:![\w]+)*(?::\w+)?\(/g)) {
    let i = m.index + m[0].length, depth = 1
    const s = i
    while (i < text.length && depth) { if (text[i] === '(') depth++; else if (text[i] === ')') depth--; i++ }
    const list = text.slice(s, i - 1)
    if (/[;{}=]|=>/.test(list)) continue
    embeds++
    const where = `${file}:${text.slice(0, m.index).split('\n').length} (${m[1]} embed)`
    const cols = topLevel(list)
    if (cols.includes('*')) bad.push(`${where}: ${m[1]}(*)`)
    if (cols.includes(HELD)) bad.push(`${where}: embeds ${m[1]}.${HELD}`)
  }
}
ok(`every jobs and recurring_series read leaves out ${HELD} and '*' (${chains} chains, ${embeds} embeds)`, bad, [])
ok('the scan found the reads (not a broken regex)', chains >= 20, true)

// ── 2. the reader ────────────────────────────────────────────────────────────
const lib = read(LIB)
ok('jobTaskPay.ts reads the column directly only when the function is missing (PGRST202)',
  /if \(error\.code !== 'PGRST202'\) throw error\s+const old = await supabase\.from\('jobs'\)\.select\('id, task_pay'\)/.test(lib), true)
ok('fetchJobTaskPay is the only caller of job_task_pay',
  SRC.filter((s) => s.file !== LIB && /rpc\(\s*'job_task_pay'/.test(s.text)).map((s) => s.file), [])

// ── 3. the inspection screen ─────────────────────────────────────────────────
const insp = read('src/screens/JobInspectionScreen.tsx')
ok('JobInspectionScreen reads Task pay through fetchJobTaskPay()', /fetchJobTaskPay\(\[job\.id\]\)/.test(insp), true)
ok('JobInspectionScreen: a pay it can\'t read raises no "pays nothing" warning',
  /setNoPay\(known && pay === 0 && \(entryCount \?\? 0\) === 0\)/.test(insp), true)

console.log(failures ? `\n${failures} failed` : '\nall passed')
if (failures) process.exit(1)
