// SHA-256 scenario test. Run with: node scripts/test-sha256.mjs
//
// The crew app's pure-TS SHA-256 (src/lib/sha256.ts) must give exactly the
// bytes' SHA-256: the web compares it with the hash of the stored file, and a
// wrong one would print a red "file changed" on every crew photo. Checked
// against node:crypto on fixed vectors, every length around the padding
// boundaries, odd update() splits, and photo-sized base64 sliced every way.
import { createHash, randomBytes } from 'node:crypto'
import { Sha256, sha256Hex, sha256HexOfBase64, base64ToBytes } from '../sha256'

let failures = 0
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}
const node = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'))
const u8 = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.length)

;(async () => {
  // ── Published vectors (FIPS 180-2) ───────────────────────────────────────
  ok('empty', sha256Hex(new Uint8Array(0)) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  ok('"abc"', sha256Hex(bytes('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  ok('448-bit message', sha256Hex(bytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')) === '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  ok('one million "a"', sha256Hex(new Uint8Array(1_000_000).fill(0x61)) === 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')

  // ── Every length through three blocks (all the padding cases) ────────────
  let lengthsOk = true
  for (let n = 0; n <= 200; n++) {
    const b = u8(randomBytes(n))
    if (sha256Hex(b) !== node(b)) { lengthsOk = false; console.log(`  length ${n} differs`) }
  }
  ok('every length 0–200 matches node:crypto', lengthsOk)

  // ── Lowercase hex, always 64 characters ──────────────────────────────────
  ok('64 lowercase hex characters (the column\'s CHECK)', Array.from({ length: 50 }, () => sha256Hex(u8(randomBytes(37)))).every(h => /^[0-9a-f]{64}$/.test(h)))

  // ── update() in pieces = all at once ─────────────────────────────────────
  const photo = u8(randomBytes(3_500_000 + 13))
  const want = node(photo)
  ok('a 3.5 MB photo in one update', sha256Hex(photo) === want)
  let splitsOk = true
  for (const cuts of [[1], [63], [64], [65], [1, 1, 1], [55, 9, 64, 1000], [131_071, 7, 98_304]]) {
    const h = new Sha256()
    let at = 0
    for (let i = 0; at < photo.length; i++) {
      const size = cuts[i % cuts.length] * (i < 50 ? 1 : 997)
      h.update(photo.subarray(at, at + size))
      at += size
    }
    if (h.digestHex() !== want) { splitsOk = false; console.log(`  split ${cuts.join(',')} differs`) }
  }
  ok('the same photo in pieces of every awkward size', splitsOk)
  ok('an empty update changes nothing', new Sha256().update(new Uint8Array(0)).update(bytes('abc')).update(new Uint8Array(0)).digestHex() === sha256Hex(bytes('abc')))

  // ── Base64 in, as expo-file-system's readAsStringAsync hands it over ─────
  const b64 = Buffer.from(photo).toString('base64')
  ok('base64 decodes to the same bytes', Buffer.from(base64ToBytes(b64)).equals(Buffer.from(photo)))
  ok('a 3.5 MB photo as base64, default slices', await sha256HexOfBase64(b64) === want)
  let slicesOk = true
  for (const slice of [4, 5, 8, 12, 4096, 65_537, 131_072, 10_000_000]) {
    const small = photo.subarray(0, slice < 100 ? 3001 : photo.length)
    const got = await sha256HexOfBase64(Buffer.from(small).toString('base64'), slice)
    if (got !== node(small)) { slicesOk = false; console.log(`  slice ${slice} differs`) }
  }
  ok('any slice size, including ones that aren\'t a multiple of 4', slicesOk)
  let tailsOk = true
  for (let n = 0; n <= 40; n++) {
    const b = u8(randomBytes(n))
    const padded = Buffer.from(b).toString('base64')
    if (await sha256HexOfBase64(padded, 8) !== node(b)) tailsOk = false
    if (await sha256HexOfBase64(padded.replace(/=+$/, ''), 8) !== node(b)) tailsOk = false
  }
  ok('every tail length, with and without = padding', tailsOk)
  const wrapped = b64.replace(/(.{76})/g, '$1\r\n')
  ok('line breaks in the base64 are skipped', await sha256HexOfBase64(wrapped) === want)

  let threw = 0
  for (const bad of ['QUJD=RA', 'QUJDR']) {
    try { await sha256HexOfBase64(bad, 4); console.log(`  ${JSON.stringify(bad)} hashed`) } catch { threw++ }
  }
  ok('not base64 (a stray =, a lone sextet): throws, never a wrong hash', threw === 2)
  // '*' and 'é' are not base64 characters: they are skipped like a line break.
  ok('…characters outside base64 are skipped like a line break', await sha256HexOfBase64('QUJD*RA==') === sha256Hex(bytes('ABCD')))

  // ── It yields: the screen keeps running while a photo is hashed ──────────
  let ticks = 0
  const ticker = setInterval(() => { ticks++ }, 0)
  const t0 = Date.now()
  await sha256HexOfBase64(b64)
  const ms = Date.now() - t0
  clearInterval(ticker)
  ok('other work runs while a 3.5 MB photo hashes', ticks > 5)
  console.log(`  (3.5 MB photo: ${ms} ms in this Node)`)

  if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1) }
  console.log('\nThe crew app\'s SHA-256 matches node:crypto.')
})().catch(e => { console.error(e); process.exit(1) })
