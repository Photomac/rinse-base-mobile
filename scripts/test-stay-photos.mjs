#!/usr/bin/env node
// A rating under 5 stars needs photos (CKS, Catherine 2026-11-10):
// src/lib/stayPhotos.ts, StayRatingCard, JobDetailScreen.
//
// Runs the REAL lib/stayPhotos.ts under Node's type stripping, and checks:
//   • the company's number: whole numbers 0-10, anything else off (no column
//     yet, no row, an error, junk);
//   • what counts: the clean's Before and Damage photos ('before', 'issue',
//     'damage'), landed or on this phone on their way, not one the server
//     refused, not After or Other;
//   • what's short: only a 1-4 star pick with the company asking; 5 stars,
//     no pick, or off is never short;
// and, in the code: the company's number is its own cached read (the day pack
// warms it); the photos are counted only when it asks; the card's Save and
// the ask's Save and complete wait for them; the ask hides Skip meanwhile;
// Take photos opens the photo screen on Before and the count is read again
// when it closes; the strings exist in en, es and pt.
//
// Usage: node scripts/test-stay-photos.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(repo, p), 'utf8')
let pass = 0, fail = 0
function check(name, got, want = true) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const between = (text, from, to) => {
  const i = text.indexOf(from)
  return i < 0 ? '' : text.slice(i, text.indexOf(to, i + from.length))
}

const P = await import(join(repo, 'src/lib/stayPhotos.ts'))

// ── the company's number ────────────────────────────────────────────────────
check('whole numbers 1-10 as they are', [1, 2, 3, 10].map(P.photosRequired), [1, 2, 3, 10])
check('off: 0, below, fractions, junk, nothing', [0, -1, 1.5, NaN, null, undefined, 'x', '', {}, true].map(P.photosRequired), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
check('a numeric string reads (PostgREST hands smallint as a number, but still)', P.photosRequired('2'), 2)
check('capped at the column\'s 10', P.photosRequired(25), 10)
check('from the tenants read',
  [P.requiredFromRead({ data: { stay_rating_photos_required: 2 }, error: null }),
   P.requiredFromRead({ data: { stay_rating_photos_required: 0 }, error: null }),
   P.requiredFromRead({ data: null, error: null }),
   P.requiredFromRead({ data: null, error: { code: '42703', message: 'column tenants.stay_rating_photos_required does not exist' } }),
   P.requiredFromRead(null)], [2, 0, 0, 0, 0])

// ── what counts ─────────────────────────────────────────────────────────────
check('Before and Damage count (damage is saved as issue; old rows say damage); After and Other don\'t',
  ['before', 'issue', 'damage', 'after', 'general', '', null].map(P.countsAsStayPhoto), [true, true, true, false, false, false, false])
const server = [{ id: 1, photo_type: 'before' }, { id: 2, photo_type: 'after' }, { id: 3, photo_type: 'issue' }, { id: 4, photo_type: 'general' }]
const queued = [{ photo_type: 'before', failing: false }, { photo_type: 'issue', failing: true }, { photo_type: 'after', failing: false }, { photo_type: 'damage' }]
check('landed plus on their way; a photo the server refused isn\'t on its way', P.stayPhotoCount(server, queued), 2 + 2)
check('nothing read (offline, no copy) counts what\'s on the phone', P.stayPhotoCount(null, queued), 2)
check('nothing anywhere', P.stayPhotoCount(undefined, 'junk'), 0)

// ── what's short ────────────────────────────────────────────────────────────
check('1-4 stars with the company asking: needs them', [1, 2, 3, 4].map(r => P.needsPhotos(r, 2)), [true, true, true, true])
check('5 stars, no pick, or off: never', [P.needsPhotos(5, 2), P.needsPhotos(0, 2), P.needsPhotos(3, 0)], [false, false, false])
check('short by what\'s missing, never below 0',
  [P.photosShort(3, 2, 0), P.photosShort(3, 2, 1), P.photosShort(3, 2, 2), P.photosShort(3, 2, 7), P.photosShort(5, 2, 0), P.photosShort(3, 0, 0), P.photosShort(0, 3, 0)],
  [2, 1, 0, 0, 0, 0, 0])

// ── the code ────────────────────────────────────────────────────────────────
const reads = read('src/lib/jobReads.ts')
check('the company\'s number: its own read, its own key, the one column',
  reads.includes('export const stayPhotosTenantRead = (tenantId: string): CacheRead => ({\n  key: `srpten:${tenantId}`,') &&
  reads.includes(".select('stay_rating_photos_required').eq('id', tenantId).maybeSingle(),"))
check('the photos read: this clean, the three types lib/stayPhotos counts',
  reads.includes("key: `srphotos:${jobId}`") && reads.includes(".select('id, photo_type').eq('job_id', jobId).in('photo_type', ['before', 'issue', 'damage']),") &&
  JSON.stringify([...P.STAY_PHOTO_TYPES]) === JSON.stringify(['before', 'issue', 'damage']))
check('the day pack warms the company\'s number for cleans (no signal still holds the rule)',
  between(reads, 'export function jobPackReads(', '\n}\n').includes('if (!isTask) reads.push(stayPhotosTenantRead(user.tenant_id))'))

const card = read('src/components/StayRatingCard.tsx')
const hook = between(card, 'export function useStayRating(', '\n/** The five stars')
check('nothing is read until the card shows; photos are counted only when the company asks',
  hook.includes('if (!enabled || !tenantId) return') && hook.includes('requiredFromRead(await cachedRead(stayPhotosTenantRead(tenantId))') &&
  hook.indexOf('if (!need) return') < hook.indexOf('cachedRead(stayPhotosRead(job.id))') && hook.includes('queuedJobPhotos(job.id)'))
check('the count is read again on request (the photo screen closed)', hook.includes('refreshPhotos: () => setPhotoTick(n => n + 1)') && /\[job\.id, enabled, tenantId, photoTick\]/.test(hook))
const cardFn = between(card, 'export function StayRatingCard(', '\n/**\n * The ask at Complete')
check('the card: Save waits for the photos, and the row shows under the stars',
  cardFn.includes('const canSave = rating > 0 && !(stay.saved && !stay.dirty) && stay.photosShort === 0') &&
  cardFn.includes('if (!rating || stay.photosShort > 0) return') && cardFn.includes('<StayPhotosRow stay={stay} onTakePhotos={onTakePhotos} />'))
const sheet = card.slice(card.indexOf('export function StayAskModal'))
check('the ask: Save and complete waits for them, Skip is hidden meanwhile, closing still just closes',
  sheet.includes('disabled={!picked || stay.saving || short > 0}') && /\{short === 0 && \(\s*\n\s*<TouchableOpacity style=\{styles\.askSkipBtn\} onPress=\{onSkip\}/.test(sheet) &&
  sheet.includes('onRequestClose={onClose}') && sheet.includes('<StayPhotosRow stay={stay} onTakePhotos={onTakePhotos} />'))
const row = between(card, 'function StayPhotosRow(', '\n}\n')
check('the row: only for a pick that needs photos; count, what\'s needed (one or many), Take photos',
  row.includes('if (!needsPhotos(stay.value.rating, stay.photosRequired)) return null') &&
  row.includes("ti(t('stay_photos_count'), { n: String(Math.min(stay.photoCount, need)), need: String(need) })") &&
  row.includes("need === 1 ? t('stay_photos_need_one') : ti(t('stay_photos_need_many'), { need: String(need) })") && row.includes("t('stay_photos_take')"))
check('the card says the app is the gate', card.includes('The app is\n// the gate') || card.includes('The app is the gate'))

const detail = read('src/screens/JobDetailScreen.tsx')
const take = between(detail, 'function takeStayPhotos() {', '\n  }')
check('Take photos: the photo screen on Before, no checklist line', take.includes('setActivePhotoItem(null)') && take.includes("setPhotosType('before')") && take.includes('setShowPhotos(true)'))
check('the card and the ask both offer it',
  detail.includes("onError={m => Alert.alert(t('error'), m)} onTakePhotos={takeStayPhotos} />") && detail.includes('onClose={() => answerStayAsk(false)}\n        onTakePhotos={takeStayPhotos} />'))
check('the photo screen opens on that type and, closing, forgets it and counts again',
  detail.includes('initialType={photosType} readOnly={readOnly} onBack={() => { setShowPhotos(false); setPhotosType(undefined); loadChecklist(); loadPhotoRequirements(); stay.refreshPhotos() }}'))
const photos = read('src/screens/JobPhotosScreen.tsx')
check('the photo screen takes the type, only one it knows, else After as before',
  photos.includes("const [selectedType, setSelectedType] = useState(() => PHOTO_TYPES.some(pt => pt.id === initialType) ? initialType as string : 'after')"))

// ── the words ───────────────────────────────────────────────────────────────
const i18n = read('src/lib/i18n.ts')
const langs = ['en', 'es', 'pt'].map(l => between(i18n, `\n  ${l}: {`, '\n  },'))
const KEYS = ['stay_photos_count', 'stay_photos_need_one', 'stay_photos_need_many', 'stay_photos_take']
check('every string in en, es and pt', langs.map(b => KEYS.every(k => b.includes(`${k}:`))), [true, true, true])
check('the counts go in each language', langs.map(b => /stay_photos_count: '[^']*\{\{n\}\}[^']*\{\{need\}\}/.test(b) && /stay_photos_need_many: '[^']*\{\{need\}\}/.test(b)), [true, true, true])
check('…naming the photo types as the photo screen labels them',
  [langs[0].includes('(Before or Damage)'), langs[1].includes('(Antes o Daño)'), langs[2].includes('(Antes ou Dano)'),
   /before: 'Before'[^\n]*damage: 'Damage'/.test(langs[0]), /before: 'Antes'[^\n]*damage: 'Daño'/.test(langs[1]), /before: 'Antes'[^\n]*damage: 'Dano'/.test(langs[2])],
  [true, true, true, true, true, true])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
