#!/usr/bin/env node
// Chat and job-thread photos get a name nobody can guess (src/lib/randomFileId.ts).
//
// They live in the public job-photos bucket, so whoever knows a path opens the
// photo. The app named them <Date.now()>.<ext>, guessable from the folder and a
// rough send time (rinse-base-app #2072 lists chat/<channel>/ only to members;
// this closes the guessing half on the phone, as the web did).
//
// Runs the REAL src/lib/randomFileId.ts under Node's type stripping and checks:
//   • each of its three sources (crypto.randomUUID, crypto.getRandomValues,
//     the Math.random fallback) gives an RFC 4122 v4 id, and 2,000 are distinct;
//   • a crypto that throws falls back instead of failing the upload;
// and, in chatAttachments.ts, that the upload path uses randomFileId() and no
// longer Date.now().
//
// Usage: node scripts/test-random-file-id.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webcrypto } from 'node:crypto'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function check(name, ok, detail = '') {
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — ${detail}`}`)
}
const { randomFileId } = await import(join(repo, 'src/lib/randomFileId.ts'))
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function withCrypto(c, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { value: c, configurable: true, writable: true })
  try { return fn() } finally {
    if (had) Object.defineProperty(globalThis, 'crypto', had)
    else delete globalThis.crypto
  }
}
function batch(label, c) {
  const ids = withCrypto(c, () => Array.from({ length: 2000 }, () => randomFileId()))
  const bad = ids.find(id => !V4.test(id))
  check(`${label}: v4-shaped`, !bad, `got ${bad}`)
  check(`${label}: 2,000 distinct`, new Set(ids).size === ids.length, `${new Set(ids).size} distinct`)
}

let usedUuid = 0, usedBytes = 0
batch('crypto.randomUUID', { randomUUID: () => { usedUuid++; return webcrypto.randomUUID() } })
check('crypto.randomUUID: used when present', usedUuid === 2000, `${usedUuid} calls`)
batch('crypto.getRandomValues', { getRandomValues: a => { usedBytes++; return webcrypto.getRandomValues(a) } })
check('crypto.getRandomValues: used when randomUUID is missing', usedBytes === 2000, `${usedBytes} calls`)
batch('no crypto (Math.random fallback)', undefined)
batch('a crypto that throws (falls back)', { randomUUID: () => { throw new Error('nope') } })

const src = readFileSync(join(repo, 'src/lib/chatAttachments.ts'), 'utf8').replace(/\/\/[^\n]*/g, '')
check('chatAttachments: upload path names the file randomFileId()', /\$\{randomFileId\(\)\}\.\$\{ext\}/.test(src))
check('chatAttachments: no Date.now() in it any more', !/Date\.now\(\)/.test(src))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
