// A property's laundry bags: how many (client_addresses.laundry_bag_count,
// web migration 20261104160500_linen_bag_count) and which (laundry_bag_color,
// free text such as "(2) green"). CKS, 2026-11-04: crews move whole bags and
// never open them, so the count and the bags are what they need to see.
// scripts/test-driver-stops.mjs drives this.

/** "2 bags · (2) green", "1 bag", "(2) green", or '' when neither is set.
 *  bagsWord(n) says the count in the crew member's language. */
export function bagLine(count: unknown, text: unknown, bagsWord: (n: number) => string): string {
  const t = String(text ?? '').trim()
  const n = typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : null
  return [n == null ? '' : bagsWord(n), t].filter(Boolean).join(' · ')
}
