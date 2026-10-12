// src/lib/sha256.ts
// SHA-256 in plain TypeScript, for a job photo's file fingerprint
// (job_photos.photo_sha256; see photoQueue.ts). The web's stamped download
// hashes the stored file and prints whether it still matches the one the crew
// app uploaded, so a property manager's damage-claim copy shows a file that was
// replaced afterwards.
//
// No native module: expo-crypto would need a new app binary, and this ships
// over the air. Hermes has no JIT, so the hash works through a photo a slice at
// a time and hands the JS thread back between slices (sha256HexOfBase64).
//
// Pure: scripts/test-sha256.mjs checks it against node:crypto.

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** An incremental SHA-256: update() with the bytes in order, then digestHex() once. */
export class Sha256 {
  private h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  private w = new Int32Array(64)
  private buf = new Uint8Array(64)
  private bufLen = 0
  private length = 0

  update(data: Uint8Array): this {
    const n = data.length
    let i = 0
    this.length += n
    if (this.bufLen > 0) {
      i = Math.min(64 - this.bufLen, n)
      this.buf.set(data.subarray(0, i), this.bufLen)
      this.bufLen += i
      if (this.bufLen < 64) return this
      this.block(this.buf, 0)
      this.bufLen = 0
    }
    for (; i + 64 <= n; i += 64) this.block(data, i)
    if (i < n) {
      this.buf.set(data.subarray(i), 0)
      this.bufLen = n - i
    }
    return this
  }

  /** The hash as 64 lowercase hex characters. Ends this hash: don't update() it again. */
  digestHex(): string {
    // Message length in bits, big-endian across two 32-bit words.
    const hi = Math.floor(this.length / 0x20000000)
    const lo = (this.length << 3) >>> 0
    const pad = new Uint8Array((this.bufLen < 56 ? 56 : 120) - this.bufLen + 8)
    pad[0] = 0x80
    const end = pad.length
    pad[end - 8] = hi >>> 24; pad[end - 7] = hi >>> 16; pad[end - 6] = hi >>> 8; pad[end - 5] = hi
    pad[end - 4] = lo >>> 24; pad[end - 3] = lo >>> 16; pad[end - 2] = lo >>> 8; pad[end - 1] = lo
    this.update(pad)
    let hex = ''
    for (let i = 0; i < 8; i++) hex += (this.h[i] >>> 0).toString(16).padStart(8, '0')
    return hex
  }

  private block(data: Uint8Array, off: number): void {
    const w = this.w
    const h = this.h
    for (let t = 0; t < 16; t++) {
      const j = off + t * 4
      w[t] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]
    }
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15]
      const y = w[t - 2]
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7]
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const t1 = (k + S1 + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0
      k = g; g = f; f = e; e = (d + t1) | 0
      d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + k) | 0
  }
}

/** The SHA-256 of these bytes, as 64 lowercase hex characters. */
export function sha256Hex(data: Uint8Array): string {
  return new Sha256().update(data).digestHex()
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const SEXTET = new Int8Array(128).fill(-1)
for (let i = 0; i < ALPHABET.length; i++) SEXTET[ALPHABET.charCodeAt(i)] = i

// Base64 with nothing but the 64 alphabet characters: no padding, and no line
// breaks (expo-file-system sends none today, but a decoder that met one would
// otherwise be off by a character from there on).
function bareBase64(b64: string): string {
  const s = /[^A-Za-z0-9+/=]/.test(b64) ? b64.replace(/[^A-Za-z0-9+/=]/g, '') : b64
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 61 /* = */) end--
  return end === s.length ? s : s.slice(0, end)
}

// Decode bare base64 (see bareBase64: every character is ASCII). Throws on a
// stray '=' or a length no base64 has.
function decodeBare(s: string): Uint8Array {
  const n = s.length
  if (n % 4 === 1) throw new Error('sha256: base64 length is not valid')
  const out = new Uint8Array(Math.floor((n * 3) / 4))
  let o = 0
  let i = 0
  let bad = 0
  for (; i + 4 <= n; i += 4) {
    const a = SEXTET[s.charCodeAt(i)], b = SEXTET[s.charCodeAt(i + 1)]
    const c = SEXTET[s.charCodeAt(i + 2)], d = SEXTET[s.charCodeAt(i + 3)]
    bad |= a | b | c | d
    const v = (a << 18) | (b << 12) | (c << 6) | d
    out[o++] = v >>> 16; out[o++] = v >>> 8; out[o++] = v
  }
  if (n - i >= 2) {
    const a = SEXTET[s.charCodeAt(i)], b = SEXTET[s.charCodeAt(i + 1)]
    const c = n - i === 3 ? SEXTET[s.charCodeAt(i + 2)] : 0
    bad |= a | b | c
    const v = (a << 18) | (b << 12) | (c << 6)
    out[o++] = v >>> 16
    if (n - i === 3) out[o++] = v >>> 8
  }
  if (bad < 0) throw new Error('sha256: not base64')
  return out
}

/** The bytes a base64 string holds. */
export function base64ToBytes(b64: string): Uint8Array {
  return decodeBare(bareBase64(b64))
}

// 48 KB of file per slice. A 3.5 MB photo took ~1 s to hash with V8's JIT off
// (scripts/test-sha256.mjs --jitless), so a slice is ~15 ms there and a few
// times that on a slow phone.
const SLICE_CHARS = 65_536

/**
 * The SHA-256 (64 lowercase hex characters) of the bytes a base64 string
 * holds, e.g. a photo read with expo-file-system's readAsStringAsync. Decodes
 * and hashes a slice at a time and yields between slices, so a 3.5 MB photo
 * doesn't freeze the screen while it is fingerprinted.
 */
export async function sha256HexOfBase64(b64: string, sliceChars = SLICE_CHARS): Promise<string> {
  const s = bareBase64(b64)
  const step = Math.max(4, sliceChars - (sliceChars % 4))
  const hash = new Sha256()
  for (let i = 0; i < s.length; i += step) {
    if (i > 0) await new Promise(resolve => setTimeout(resolve, 0))
    hash.update(decodeBare(s.slice(i, i + step)))
  }
  return hash.digestHex()
}
