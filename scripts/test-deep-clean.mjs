#!/usr/bin/env node
// "Needs a deep clean" in Report an issue (CKS Perfections, 2026-10-22).
//
// Runs the REAL src/lib/deepClean.ts under Node's type stripping and checks:
//   • the title lists the tapped items in list order, then Other's words (one
//     line, at most 80 characters); ready only with something picked, never
//     with Other ticked and empty;
//   • it is the web's rule: the same ids, English labels, titles and
//     readiness as rinsebase-app src/lib/deepClean.ts over a grid of taps,
//     the same icon and color as the web picker, and a type the database's
//     CHECK allows (when the web repo is on this machine);
//   • the card: the type sits after maintenance with 🧽, is unrated (no
//     severity), saves the composed English title, clears its taps on reset,
//     and shows each chip in the crew's language;
//   • inspectors get the card too (JobDetailScreen: cleans and inspections);
//   • every string it uses is in English, Spanish and Portuguese.
//
// Usage: node scripts/test-deep-clean.mjs
//   From a worktree, point the parity check at the web repo:
//   RINSEBASE_WEB_REPO=/path/to/rinsebase-app node scripts/test-deep-clean.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const read = p => readFileSync(join(repo, p), 'utf8')
const D = await import(pathToFileURL(join(repo, 'src/lib/deepClean.ts')).href)

// ── The rule ─────────────────────────────────────────────────────────────────
check("the regulars, in Catherine's order", D.DEEP_CLEAN_ITEMS.map(i => i.label),
  ['Oven', 'Grill', 'Cobwebs inside', 'Cobwebs outside', 'Blinds', 'Ceiling fans'])
check('title: list order, whatever order they were tapped', D.deepCleanTitle(['fans', 'oven', 'cobwebs_in'], ''), 'Deep clean: Oven, Cobwebs inside, Ceiling fans')
check("title: Other's words last, on one line", D.deepCleanTitle(['grill'], '  patio\n furniture  '), 'Deep clean: Grill, patio furniture')
check("title: Other's words cut at 80", D.deepCleanTitle([], 'x'.repeat(200)).length, 'Deep clean: '.length + 80)
check('title: nothing picked is empty', [D.deepCleanTitle([], ''), D.deepCleanTitle(['nope'], '  ')], ['', ''])
check('ready: an item; Other with words', [D.deepCleanReady(['oven'], false, ''), D.deepCleanReady([], true, 'Baseboards')], [true, true])
check('not ready: nothing; Other ticked and empty; words with Other not ticked',
  [D.deepCleanReady([], false, ''), D.deepCleanReady(['oven'], true, ' '), D.deepCleanReady([], false, 'Baseboards')], [false, false, false])

// ── The web's rule ───────────────────────────────────────────────────────────
const WEB = process.env.RINSEBASE_WEB_REPO || join(repo, '..', 'rinsebase-app')
const webLib = join(WEB, 'src/lib/deepClean.ts')
if (existsSync(webLib)) {
  const W = await import(pathToFileURL(webLib).href)
  check('same ids and labels as the web', D.DEEP_CLEAN_ITEMS.map(i => [i.id, i.label]), W.DEEP_CLEAN_ITEMS.map(i => [i.id, i.label]))
  check('same Other limit', D.DEEP_CLEAN_OTHER_MAX, W.DEEP_CLEAN_OTHER_MAX)
  const ids = D.DEEP_CLEAN_ITEMS.map(i => i.id)
  const others = ['', '  ', 'Baseboards', ' porch\tlights ', 'y'.repeat(120)]
  let n = 0, diff = []
  for (let mask = 0; mask < 1 << ids.length; mask++) {
    const picked = ids.filter((_, k) => mask & (1 << k)).reverse()
    for (const o of others) for (const on of [false, true]) {
      n++
      const mine = [D.deepCleanTitle(picked, on ? o : ''), D.deepCleanReady(picked, on, o)]
      const theirs = [W.deepCleanTitle(picked, on ? o : ''), W.deepCleanReady(picked, on, o)]
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) diff.push({ picked, o, on, mine, theirs })
    }
  }
  check(`same title and readiness as the web over ${n} tap sets`, diff.slice(0, 3), [])
  const webTab = readFileSync(join(WEB, 'src/components/DamageReportTab.tsx'), 'utf8')
  const webRow = /\{ id: 'deep_clean',[^}]*icon: '([^']+)', color: '([^']+)' \}/.exec(webTab)
  const myRow = /\{ id: 'deep_clean',[^}]*icon: '([^']+)', color: '([^']+)' \}/.exec(read('src/components/IncidentReportCard.tsx'))
  check("same icon and color as the web picker", myRow && [myRow[1], myRow[2]], webRow && [webRow[1], webRow[2]])
  const migs = readdirSync(join(WEB, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()
  const last = migs.map(f => /add constraint job_damage_reports_report_type_check\s+check \(report_type = any \((?:ARRAY)?\s*\[([^\]]*)\]/i.exec(readFileSync(join(WEB, 'supabase/migrations', f), 'utf8'))?.[1]).filter(Boolean).at(-1) ?? ''
  check("the database's report_type CHECK allows 'deep_clean'", /'deep_clean'/.test(last), true)
} else {
  console.log(`–  web parity skipped (no ${webLib})`)
}

// ── The card ─────────────────────────────────────────────────────────────────
const card = read('src/components/IncidentReportCard.tsx')
check('the type: after maintenance, 🧽', /\{ id: 'maintenance'[^\n]*\n\s*\{ id: 'deep_clean',\s*labelKey: 'ir_type_deep_clean',\s*icon: '🧽'/.test(card), true)
check('unrated: no severity, saved as minor like lost & found and linen', [
  /const unrated = isLF \|\| isLinen \|\| isDeep/.test(card), /const sev = unrated \? 'minor' : severity/.test(card),
], [true, true])
check('saves the composed title, ready by the shared rule', [
  /const finalTitle = isDeep \? deepTitle :/.test(card),
  /const deepTitle = deepCleanTitle\(deepItems, deepOtherOn \? deepOther : ''\)/.test(card),
  /canSubmit = isDeep \? deepCleanReady\(deepItems, deepOtherOn, deepOther\)/.test(card),
], [true, true, true])
check('reset clears the taps and Other', /setDeepItems\(\[\]\); setDeepOtherOn\(false\); setDeepOther\(''\)/.test(card), true)
check("chips in the crew's language; Other's box capped like the title", [
  /\{t\(i\.labelKey\)\}/.test(card), /maxLength=\{DEEP_CLEAN_OTHER_MAX\}/.test(card),
], [true, true])
const detail = read('src/screens/JobDetailScreen.tsx')
check('inspectors get the card: cleans and inspections', /\{isStarted && \(!isTask \|\| isInspection\) && <IncidentReportCard /.test(detail), true)

// ── Strings ──────────────────────────────────────────────────────────────────
const i18n = read('src/lib/i18n.ts')
const block = lang => { const a = i18n.indexOf(`\n  ${lang}: {`); const rest = i18n.slice(a + 5); const b = rest.search(/\n  [a-z]{2}: \{|\n\}\n/); return rest.slice(0, b) }
const used = new Set([
  ...[...card.matchAll(/'(ir_deep_[a-z_]+|ir_type_deep_clean)'/g)].map(m => m[1]),
  ...D.DEEP_CLEAN_ITEMS.map(i => i.labelKey),
])
for (const lang of ['en', 'es', 'pt']) {
  const b = block(lang)
  check(`every deep-clean string is in ${lang} (${used.size})`, [...used].filter(k => !new RegExp(`\\n\\s+${k}:`).test(b)), [])
}
check('Report an issue says it covers a deep clean, in all three', ['en', 'es', 'pt'].map(l => /ir_sub: '[^']*(deep clean|limpieza profunda|limpeza profunda)/.test(block(l))), [true, true, true])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
