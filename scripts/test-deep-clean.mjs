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
//   • every string it uses is in English, Spanish and Portuguese;
//   • a photo of each thing tapped (CKS 2026-10-23): one slot per item and
//     Other, the web's slots, read-back and missing rule over the same grid;
//     the card won't save without a photo in every slot and queues each with
//     its English label; the photo queue sends the label (only when there is
//     one); the "Sent back to you" card on Home answers a send-back, its
//     answer waiting for its photos; a send-back push tap opens Home.
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
  // the photo slots: the same slots, read-back and missing rule as the web
  const slotKeys = s => s.map(x => [x.key, x.label])
  let sn = 0, sdiff = []
  for (let mask = 0; mask < 1 << ids.length; mask++) {
    const picked = ids.filter((_, k) => mask & (1 << k))
    for (const o of others) for (const on of [false, true]) {
      sn++
      const mine = slotKeys(D.deepCleanSlots(picked, on, o))
      const theirs = slotKeys(W.deepCleanSlots(picked, on, o))
      const title = D.deepCleanTitle(picked, on ? o : '')
      const back = [slotKeys(D.deepCleanSlotsFromTitle(title)), slotKeys(W.deepCleanSlotsFromTitle(title))]
      if (JSON.stringify(mine) !== JSON.stringify(theirs) || JSON.stringify(back[0]) !== JSON.stringify(back[1])) sdiff.push({ picked, o, on })
    }
  }
  check(`same photo slots and read-back as the web over ${sn} tap sets`, sdiff.slice(0, 3), [])
  check('same missing rule as the web', slotKeys(D.deepCleanMissing(D.deepCleanSlotsFromTitle('Deep clean: Oven, Grill, porch lights'), { u: 'Grill' })),
    slotKeys(W.deepCleanMissing(W.deepCleanSlotsFromTitle('Deep clean: Oven, Grill, porch lights'), { u: 'Grill' })))
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

// ── A photo of each ──────────────────────────────────────────────────────────
check('slots: tapped items in list order (with their chip key), then Other', D.deepCleanSlots(['fans', 'oven'], true, ' rugs '),
  [{ key: 'oven', label: 'Oven', labelKey: 'ir_deep_oven' }, { key: 'fans', label: 'Ceiling fans', labelKey: 'ir_deep_fans' }, { key: 'other', label: 'rugs' }])
check('ready only with a photo in every slot', [
  D.deepCleanPhotosReady(D.deepCleanSlots(['oven'], false, ''), { oven: ['x'] }),
  D.deepCleanPhotosReady(D.deepCleanSlots(['oven', 'grill'], false, ''), { oven: ['x'] }),
], [true, false])
check('the card: saves only with a photo in every slot; queues each with its English label', [
  /canSubmit = isDeep \? deepCleanReady\(deepItems, deepOtherOn, deepOther\) && deepPhotosOk/.test(card),
  /incident_report_id: reportId, label: sl\.label \}\)/.test(card),
  /for \(const sl of deepSlots\)/.test(card),
], [true, true, true])
check('the card: no plain photo row for a deep clean; untapping drops its photos; reset and cancel clear them', [
  /\{!isDeep && \(\s*<TouchableOpacity style=\{styles\.photoBtn\}/.test(card), /if \(sel\) dropSlot\(i\.id\)/.test(card),
  /if \(deepOtherOn\) dropSlot\('other'\)/.test(card), /setDeepPhotos\(\{\}\)/.test(card),
  /Object\.values\(deepPhotos\)\.flat\(\)\.forEach\(u => \{ discardCapturedPhoto\(u\) \}\)/.test(card),
], [true, true, true, true, true])
check("the card: Save says which photo is missing (still tappable for a deep clean with its taps done)", [
  /ti\(t\('ir_deep_photo_need'\), \{ items:/.test(card),
  /disabled=\{\(!canSubmit && !\(isDeep && deepCleanReady\(deepItems, deepOtherOn, deepOther\)\)\) \|\| saving\}/.test(card),
], [true, true])
const queue = read('src/lib/photoQueue.ts')
check('the photo queue keeps the label and sends it only when there is one (old photos stay the two-argument call)', [
  /\.\.\.\(p\.label \? \{ incident_photo_label: p\.label \} : \{\}\)/.test(queue),
  /\.\.\.\(entry\.incident_photo_label \? \{ p_label: entry\.incident_photo_label \} : \{\}\)/.test(queue),
], [true, true])
const notify = read('src/lib/incidentNotify.ts')
check('the answer waits for that report\'s photos (a refused one gives way after 3), and a refusal as someone else\'s lets it go', [
  /if \(await photosAheadOfAnswer\(a\.report_id\) > 0\) \{ keep\.push\(a\); continue \}/.test(notify),
  // a photo the server keeps refusing gives way (as for a queued Complete), so the answer is never held for good
  /\.filter\(p => !\(p\.lastErrorKind === 'server' && refusalsOf\(p\) >= REFUSALS_BEFORE_COMPLETE_GOES\)\)/.test(queue),
  /supabase\.rpc\('answer_incident_send_back', \{ p_report_id: a\.report_id, p_note: a\.note \}\)/.test(notify),
  /if \(error && \(error as any\)\.code !== '42501'\) keep\.push\(a\)/.test(notify),
  /try \{ await flushSendBackAnswers\(\) \} catch/.test(notify),
], [true, true, true, true, true])
const sbc = read('src/components/SentBackCard.tsx')
const dash = read('src/screens/DashboardScreen.tsx')
const app = read('App.tsx')
check('Sent back to you: on Home, only what was sent to me and still open, minus answers waiting on this phone', [
  /<SentBackCard user=\{user\} \/>/.test(dash),
  /\.eq\('sent_to', user\.id\)\.is\('answered_at', null\)/.test(sbc),
  /!r\.report\.host_notified_at && \['reported', 'reviewed'\]\.includes\(r\.report\.status\) && !answered\.has\(r\.report\.id\)/.test(sbc),
], [true, true, true])
check('Sent back to you: a slot per thing the request names, photos labelled, then the answer', [
  /const slots = deep \? deepCleanSlotsFromTitle\(w\.report\.title\) : \[ANY_PHOTO\]/.test(sbc),
  /incident_report_id: w\.report\.id, label: deep \? sl\.label : null/.test(sbc),
  /await queueSendBackAnswer\(\{ report_id: w\.report\.id, note: note\.trim\(\) \|\| null \}\)/.test(sbc),
  /if \(!all\.length && !note\.trim\(\)\) \{ Alert\.alert\(t\('sb_need_something'\)\); return \}/.test(sbc),
], [true, true, true, true])
check('a send-back push tap opens Home (its own effect, once per tap)', [
  /type !== 'incident_sent_back'\) return\s*\n\s*taps\.first\(lastResponse\.notification\.request\.identifier\)[\s\S]{0,300}navigationRef\.navigate\('Dashboard'\)/.test(app),
  /else pendingTab\.current = 'Dashboard'/.test(app),
], [true, true])

// ── Strings ──────────────────────────────────────────────────────────────────
const i18n = read('src/lib/i18n.ts')
const block = lang => { const a = i18n.indexOf(`\n  ${lang}: {`); const rest = i18n.slice(a + 5); const b = rest.search(/\n  [a-z]{2}: \{|\n\}\n/); return rest.slice(0, b) }
const used = new Set([
  ...[...card.matchAll(/'(ir_deep_[a-z_]+|ir_type_deep_clean)'/g)].map(m => m[1]),
  ...[...sbc.matchAll(/'(sb_[a-z_]+|ir_deep_[a-z_]+)'/g)].map(m => m[1]),
  ...D.DEEP_CLEAN_ITEMS.map(i => i.labelKey),
])
for (const lang of ['en', 'es', 'pt']) {
  const b = block(lang)
  check(`every deep-clean string is in ${lang} (${used.size})`, [...used].filter(k => !new RegExp(`\\n\\s+${k}:`).test(b)), [])
}
check('Report an issue says it covers a deep clean, in all three', ['en', 'es', 'pt'].map(l => /ir_sub: '[^']*(deep clean|limpieza profunda|limpeza profunda)/.test(block(l))), [true, true, true])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
