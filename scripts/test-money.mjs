#!/usr/bin/env node
// The company's currency on every amount the crew app prints (EUR/GBP, plan
// A3, 2026-10-27; iClean, Galway, is the first euro company).
//
// Rule (Todd): only the symbol changes. A usd/cad/nzd company sees exactly
// what it saw before; an eur/gbp company sees the same digits after € / £.
//
// Runs the REAL src/lib/money.ts under Node's type stripping and checks:
//   • the symbol table, the company singleton (set, cleared, unknown codes),
//     and that an explicit code wins over the company's;
//   • every call site, read out of the screen it lives in and run over a
//     corpus of amounts (zero, -0, cents, half-cents, thousands, millions,
//     negatives, strings from numeric columns): usd, cad and nzd print exactly
//     what the code before this change printed, eur and gbp print the same
//     digits after € and £;
//   • App.tsx reads tenants.currency with the other company settings, keeps
//     it on the offline profile, sets it before the first paint (cached
//     profile too) and clears it on sign-out;
//   • no hardcoded money "$" is left anywhere in the app (and the scan itself
//     catches the shapes it is meant to catch).
//
// Usage: node scripts/test-money.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const read = p => readFileSync(join(repo, p), 'utf8')

const M = await import(join(repo, 'src/lib/money.ts'))
const { CURRENCY_SYMBOL, setCurrentCurrency, currencySymbol, formatMoney } = M

// ── The symbol ──────────────────────────────────────────────────────────────
check('the table', { ...CURRENCY_SYMBOL }, { usd: '$', cad: '$', nzd: '$', eur: '€', gbp: '£' })
setCurrentCurrency(null)
check('no company yet → $', currencySymbol(), '$')
for (const [code, sym] of [['usd', '$'], ['cad', '$'], ['nzd', '$'], ['eur', '€'], ['gbp', '£']]) {
  setCurrentCurrency(code)
  check(`company ${code} → ${sym}`, currencySymbol(), sym)
}
setCurrentCurrency(' EUR ')
check('a code is read case- and space-insensitively', currencySymbol(), '€')
setCurrentCurrency('jpy')
check('an unknown company code → $, as before', currencySymbol(), '$')
setCurrentCurrency('constructor')
check('an Object.prototype name is not a currency', currencySymbol(), '$')
setCurrentCurrency('gbp')
check('an explicit code wins over the company', currencySymbol('eur'), '€')
check('an explicit usd wins over a gbp company', currencySymbol('usd'), '$')
check('an unknown explicit code → the company', currencySymbol('xyz'), '£')
check('a null explicit code → the company', currencySymbol(null), '£')
setCurrentCurrency(undefined)
check('cleared (sign-out) → $', currencySymbol(), '$')
check('formatMoney with an explicit code', formatMoney(-1234.5, { code: 'gbp' }), '-£1,234.50')
check('formatMoney decimals', formatMoney(1234.5, { code: 'eur', decimals: 0 }), '€1,235')

// ── Every call site, run from its own source ────────────────────────────────
// Amounts that exercise rounding, grouping and sign handling. Strings stand in
// for numeric columns PostgREST returns as text.
const CORPUS = [0, -0, 0.01, 0.1, 0.125, 0.5, 1, 1.005, 1.234, 2.675, 12.345, 19.999, 99.995, 100,
  203.85, 999.999, 1000, 1234.5, 1234.567, 99999.99, 1e6, 1234567.891, -0.01, -5, -12.345, -1234.5]

// The code before this change, verbatim, with the old helper it called.
const usDollars = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const OLD = {
  dashboardEarnings: (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
  petFeePrompt: (n) => `$${n}`,
  petFeeLabel: (n) => ` — $${n}`,
  laundryPrefix: () => '$',
  laundrySpent: (n) => `$${n.toFixed(2)}`,
  laundryMismatch: (n) => `($${Math.abs(n - (0 + 0)).toFixed(2)})`,
  mileageFmt: (n) => '$' + n.toFixed(2),
  myWeekMoney: (n) => `${n < 0 ? '-' : ''}$${usDollars(Math.abs(n))}`,
  profileHourly: (n) => '$' + Number(n).toFixed(2),
  profilePerJob: (n) => '$' + Number(n).toFixed(2),
}

// Pull an expression out of a screen and turn it into a function of the
// amount. `bind` maps the amount onto the names the expression reads; `wrap`
// adds the JSX text around it.
function site(file, re, names, bind, wrap = s => s) {
  const src = read(file)
  const m = src.match(re)
  if (!m) return { file, missing: true }
  const exprs = m.slice(1).map(e => e.replace(/!(?=[\s)])/g, '')) // drop TS non-null "!"
  const fns = exprs.map(e => new Function('currencySymbol', 'formatMoney', ...names, `return (${e})`))
  return { file, run: (n) => wrap(fns.map(f => f(currencySymbol, formatMoney, ...bind(n))).join('')) }
}
const SITES = {
  dashboardEarnings: site('src/screens/DashboardScreen.tsx',
    /monthStats\.earnings == null \? '—' : (`\$\{currencySymbol\(\)\}\$\{monthStats\.earnings\.toLocaleString\('en-US', \{ minimumFractionDigits: 2 \}\)\}`)/,
    ['monthStats'], n => [{ earnings: n }]),
  petFeePrompt: site('src/screens/JobDetailScreen.tsx',
    /ti\(t\('pet_prompt_yes_fee'\), \{ fee: (`\$\{currencySymbol\(\)\}\$\{petFee\}`) \}\)/, ['petFee'], n => [n]),
  petFeeLabel: site('src/screens/JobDetailScreen.tsx',
    /\{t\('pet_at_clean'\)\}\{petFee > 0 \? (` — \$\{currencySymbol\(\)\}\$\{petFee\}`) : ''\}/, ['petFee'], n => [n]),
  laundryPrefix: site('src/screens/LaundryRunScreen.tsx',
    /<Text style=\{styles\.moneyPrefix\}>\{(currencySymbol\(\))\}<\/Text>/, [], () => []),
  laundrySpent: site('src/screens/LaundryRunScreen.tsx',
    /spent !== null \? (`\$\{currencySymbol\(\)\}\$\{spent\.toFixed\(2\)\}`) : '—'/, ['spent'], n => [n]),
  // JSX text: "(" {symbol}{digits} ")" renders as one string.
  laundryMismatch: site('src/screens/LaundryRunScreen.tsx',
    /\{t\('laundry_mismatch'\)\} \(\{(currencySymbol\(\))\}\{(Math\.abs\(given! - \(loaded! \+ pouch!\)\)\.toFixed\(2\))\}\)/,
    ['given', 'loaded', 'pouch'], n => [n, 0, 0], s => `(${s})`),
  mileageFmt: site('src/screens/MileageScreen.tsx',
    /function fmt\$\(n: number\) \{ return (currencySymbol\(\) \+ n\.toFixed\(2\)) \}/, ['n'], n => [n]),
  myWeekMoney: site('src/screens/MyWeekScreen.tsx',
    /const money = \(n: number\) => (formatMoney\(n\))\n/, ['n'], n => [n]),
  profileHourly: site('src/screens/ProfileScreen.tsx',
    /ti\(t\('rate_per_hour'\), \{ amt: (currencySymbol\(\) \+ Number\(user\.hourly_rate\)\.toFixed\(2\)) \}\)/,
    ['user'], n => [{ hourly_rate: n }]),
  profilePerJob: site('src/screens/ProfileScreen.tsx',
    /ti\(t\('rate_per_job'\), \{ amt: (currencySymbol\(\) \+ Number\(user\.per_job_rate\)\.toFixed\(2\)) \}\)/,
    ['user'], n => [{ per_job_rate: n }]),
}
for (const [name, s] of Object.entries(SITES)) {
  if (s.missing) { check(`${name}: found in ${s.file}`, false, true); continue }
  const amounts = name.startsWith('profile') ? [...CORPUS, ...CORPUS.map(String), '18.5', '0'] : CORPUS
  for (const code of ['usd', 'cad', 'nzd', 'eur', 'gbp']) {
    setCurrentCurrency(code)
    const sym = CURRENCY_SYMBOL[code]
    const got = amounts.map(n => s.run(n))
    const want = amounts.map(n => OLD[name](n).replace('$', sym))
    check(`${name} (${s.file.split('/').pop()}) ${code}: ${code === 'usd' || sym === '$' ? 'exactly as before' : `same digits after ${sym}`}`, got, want)
  }
}
setCurrentCurrency(null)
check('a usd sample reads as it always did', ['dashboardEarnings', 'myWeekMoney', 'mileageFmt'].map(k => SITES[k].run(1234.5)), ['$1,234.50', '$1,234.50', '$1234.50'])
setCurrentCurrency('eur')
check('the same sample for a euro company', ['dashboardEarnings', 'myWeekMoney', 'mileageFmt'].map(k => SITES[k].run(-1234.5)), ['€-1,234.50', '-€1,234.50', '€-1234.50'])
setCurrentCurrency(null)

for (const f of ['DashboardScreen', 'JobDetailScreen', 'LaundryRunScreen', 'MileageScreen', 'ProfileScreen']) {
  check(`${f} imports currencySymbol from the shared lib`, /import \{ currencySymbol \} from '\.\.\/lib\/money'/.test(read(`src/screens/${f}.tsx`)), true)
}
check('MyWeekScreen imports formatMoney from the shared lib', /import \{ formatMoney \} from '\.\.\/lib\/money'/.test(read('src/screens/MyWeekScreen.tsx')), true)
check('MyWeekScreen has no private dollar helper left', /usDollars/.test(read('src/screens/MyWeekScreen.tsx')), false)

// ── App.tsx: read with the company settings, kept offline, set before paint ──
const app = read('App.tsx')
const settingsFn = app.slice(app.indexOf('async function companySettings('), app.indexOf('\n}\n', app.indexOf('async function companySettings(')))
check('companySettings reads tenants.currency', /from\('tenants'\)\s*\.select\('[^']*\bcurrency\b[^']*'\)/.test(settingsFn), true)
check('…and keeps it as _currency', /_currency: tenant\?\.currency \|\| null,/.test(settingsFn), true)
check('the settings type carries _currency', /type CompanySettings = \{[\s\S]*?\n  _currency: string \| null\n[\s\S]*?\n\}/.test(app), true)
check('the default is null (→ $)', /const defaultSettings = \(\): CompanySettings => \(\{\n[^\n]*_currency: null,/.test(app), true)
check('last good settings (weak signal) keep the currency', /const settingsFrom = [\s\S]*?_currency: p\._currency \?\? null,[\s\S]*?\n\}\)/.test(app), true)
check('set before setUser, next to the zone, on every profile path (cached too)',
  /setCurrentTz\(effective\?\._tz\)\n\s*setCurrentCurrency\(effective\?\._currency\)\n\s*setUser\(effective\)/.test(app), true)
check('cleared on sign-out with the zone', /setCurrentTz\(null\)\n\s*setCurrentCurrency\(null\)/.test(app), true)
check('App.tsx imports setCurrentCurrency', /import \{ setCurrentCurrency \} from '\.\/src\/lib\/money'/.test(app), true)

// ── No hardcoded money "$" left ─────────────────────────────────────────────
// A "$" that isn't the start of a template "${": '$', `$${x}`, >$<. And JSX
// text like "($" + "{x}" on a line with no template literal. Whole-line
// comments are skipped; so is this lib's own table. Not money: a regex's end
// anchor ("$/") and a name ending in "$" (Mileage's fmt$).
function dollarLines(text) {
  const hits = []
  text.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
    const code = line.replace(/\s\/\/ .*$/, '').replace(/\$(?=\/)/g, '').replace(/\b([A-Za-z_]\w*)\$/g, '$1')
    if (/\$(?!\{)/.test(code) || (/\$\{/.test(code) && !code.includes('`'))) hits.push(i + 1)
  })
  return hits
}
check('scan: catches `$${x}`', dollarLines('  const a = `$${x}`').length, 1)
check("scan: catches '$' + x", dollarLines("  const a = '$' + x").length, 1)
check('scan: catches >$<', dollarLines('  <Text>$</Text>').length, 1)
check('scan: catches JSX text ($ then {x}', dollarLines('  ⚠ {t(k)} (${a.toFixed(2)})').length, 1)
check('scan: lets a template `${x}` through', dollarLines('  const a = `${x} mi`').length, 0)
check('scan: lets comments through', dollarLines('  // was $5\n   * $1,234.50').length, 0)
check('scan: lets a regex end anchor through', dollarLines('  const re = /^\\d{4}$/i').length, 0)
check('scan: lets a name ending in $ through', dollarLines('  { amt: fmt$(miles * rate) }').length, 0)
check("scan: …but not a '$' on the same line", dollarLines("  fmt$(x) + '$'").length, 1)
check('scan: …nor `$${x}` after a regex', dollarLines('  /a$/.test(s) ? `$${x}` : ""').length, 1)

const ALLOW = new Set(['src/lib/money.ts']) // the symbol table itself
function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : walk(p)
    return /\.(ts|tsx)$/.test(name) ? [p] : []
  })
}
const files = [join(repo, 'App.tsx'), ...walk(join(repo, 'src'))]
const leftovers = files.flatMap(p => {
  const rel = relative(repo, p)
  if (ALLOW.has(rel)) return []
  return dollarLines(readFileSync(p, 'utf8')).map(n => `${rel}:${n}`)
})
check(`no hardcoded money "$" in App.tsx or src (${files.length} files)`, leftovers, [])

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
