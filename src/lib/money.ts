// src/lib/money.ts
// The company's currency symbol for every amount the crew app prints.
//
// WHY THIS EXISTS: every amount on the phone (Home earnings, My week, Mileage,
// the pay card on Profile, the laundry run, the pet fee) was written with a
// hardcoded "$". That was right for usd, cad and nzd, which all print "$", and
// wrong the day a company bills in euro or pounds (iClean, Galway, is first).
//
// RULE (Todd, 2026-10-27): only the symbol changes. Each screen keeps its own
// number formatting, so a usd/cad/nzd company sees byte-for-byte what it saw
// before, and an eur/gbp company sees the same digits after "€" / "£".
// scripts/test-money.mjs holds every call site to that.

/** Symbol per tenants.currency code. An unknown code prints "$", as before. */
export const CURRENCY_SYMBOL: Readonly<Record<string, string>> = Object.freeze({
  usd: '$', cad: '$', nzd: '$', eur: '€', gbp: '£',
})

// The company's currency code, set once from the profile load in App.tsx (the
// same place as the tenant zone) and reused by every screen. Null until the
// tenant row lands, on sign-out, and for a code this file doesn't know.
let _currency: string | null = null

function known(code: string | null | undefined): string | null {
  const c = typeof code === 'string' ? code.trim().toLowerCase() : ''
  return c && Object.prototype.hasOwnProperty.call(CURRENCY_SYMBOL, c) ? c : null
}

/** Set the company currency (tenants.currency). Called from App.tsx on profile
 *  load, including the cached-profile path, so an offline crew member still
 *  gets the company's symbol. */
export function setCurrentCurrency(code: string | null | undefined) {
  _currency = known(code)
}

/** The symbol to print: an explicit code wins, then the company's, then "$". */
export function currencySymbol(code?: string | null): string {
  return CURRENCY_SYMBOL[known(code) ?? _currency ?? 'usd']
}

/** An amount the way My week writes it: sign first, US grouping, two decimals
 *  ("-$1,234.50", "€0.00"). */
export function formatMoney(n: number, opts: { code?: string | null; decimals?: number } = {}): string {
  const d = opts.decimals ?? 2
  const digits = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
  return `${n < 0 ? '-' : ''}${currencySymbol(opts.code)}${digits}`
}
