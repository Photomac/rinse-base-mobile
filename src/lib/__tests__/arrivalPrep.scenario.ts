// Arrival-prep scenario test. Run with: node scripts/test-arrival-prep.mjs
//
// Exercises the REAL src/lib/arrivalPrep.ts (pure): the read's rows → the
// "From the arrival prep" card on a turnover. Then checks the wiring on the
// source text: the one read and its hinted embeds, the day pack and the cache
// pruner knowing its key, the card making no reads of its own and opening the
// app's photo viewer, the screen mounting it on cleans, and every string in
// all three languages.
//
// Asked for by CKS Perfections (2026-11-11): the arrival prep films and
// photographs how the guest left the home; by the time the turnover crew get
// there that state is gone, so it belongs with the clean.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { arrivalFromRows, arrivalGroupOf, arrivalPhotoGroups, arrivalEmptyLine, arrivalStage } from '../arrivalPrep'

let failures = 0
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const repo = process.env.RINSEBASE_MOBILE_REPO as string
const src = (p: string) => readFileSync(join(repo, p), 'utf8')

const URL = (n: string) => `https://cbnbhwclbtowfbjylnph.supabase.co/storage/v1/object/public/job-photos/t-cks/J-arr/${n}.jpg`
const photo = (id: string, type: string | null, at: string, extra: Record<string, unknown> = {}) => ({
  id, photo_url: URL(id), photo_type: type, caption: null, created_at: at, taken_at: null, users: { full_name: 'Dana Reyes' }, ...extra,
})
// As PostgREST returns arrivalPrepRead: job_arrivals rows, the arrival embedded
// one-to-one (an object), its crew, photos and video ids.
const linkRow = (arrival: Record<string, unknown> | null) => [{ job_id: 'J-arr', arrival }]
const arrival = (extra: Record<string, unknown> = {}) => ({
  id: 'J-arr', status: 'completed', scheduled_start: '2026-11-12T16:00:00+00:00', started_at: '2026-11-12T16:07:00+00:00',
  crew: [{ is_lead: true, users: { full_name: 'Dana Reyes' } }],
  job_photos: [], job_videos: [],
  ...extra,
})

// ── nothing to show ──
ok('no row: nothing linked, no card', arrivalFromRows([]) === null && arrivalFromRows(null) === null && arrivalFromRows(undefined) === null)
ok('an arrival the read could not see (embed null): no card', arrivalFromRows(linkRow(null)) === null)
ok('an arrival called off with nothing recorded: no card', arrivalFromRows(linkRow(arrival({ status: 'cancelled' }))) === null)
const calledOffWithVideo = arrivalFromRows(linkRow(arrival({ status: 'cancelled', job_videos: [{ id: 'v1' }] })))
ok('…but one called off after it filmed: shown', calledOffWithVideo?.videos === 1)

// ── the photo groups ──
ok('before → as the guest left it; issue and damage → damage; after → after the prep; anything else → other',
  ['before', 'issue', 'damage', 'after', 'general', 'checklist', null].map(arrivalGroupOf).join() === 'before,damage,damage,after,other,other,other')

const full = arrivalFromRows(linkRow(arrival({
  job_photos: [
    photo('after1', 'after', '2026-11-12T16:40:00Z'),
    photo('b2', 'before', '2026-11-12T16:12:00Z'),
    photo('gen', 'general', '2026-11-12T16:20:00Z'),
    photo('b1', 'before', '2026-11-12T16:30:00Z', { taken_at: '2026-11-12T16:09:00Z' }),   // saved late, taken first
    photo('dmg', 'issue', '2026-11-12T16:15:00Z', { caption: '  Wine on the rug  ' }),
    photo('nourl', 'before', '2026-11-12T16:10:00Z', { photo_url: '' }),
    null,
  ],
  job_videos: [{ id: 'v1' }, { id: 'v2' }],
})))!
ok('every photo with a url, none without', full.photos.length === 5, String(full.photos.length))
ok('in the card\'s order: as the guest left it, damage, other, after the prep; oldest first within (taken, else saved)',
  full.photos.map(p => p.id).join() === 'b1,b2,dmg,gen,after1', full.photos.map(p => p.id).join())
ok('the caption trimmed, who took it short', full.photos[2].caption === 'Wine on the rug' && full.photos[2].by === 'Dana R.')
ok('the groups that have photos, in order', arrivalPhotoGroups(full.photos).map(g => `${g.group}:${g.photos.length}`).join() === 'before:2,damage:1,other:1,after:1')
ok('the videos are counted', full.videos === 2)
ok('when: its start', full.at === '2026-11-12T16:07:00+00:00')
ok('nothing empty to say', arrivalEmptyLine(full) === null)

// ── who ──
const team = arrivalFromRows(linkRow(arrival({ crew: [
  { is_lead: false, users: { full_name: 'Sam Ortiz' } },
  { is_lead: true, users: { full_name: 'Alex  Kim' } },
  { is_lead: false, users: null },
  { is_lead: false, users: [{ full_name: 'Sam Ortiz' }] },
] })))!
ok('the crew, lead first, short, each once (a name the read hides is left out)', team.who.join(' | ') === 'Alex K. | Sam O.', team.who.join(' | '))
const nobody = arrivalFromRows(linkRow(arrival({ crew: [], job_photos: [photo('p', 'before', '2026-11-12T16:10:00Z'), photo('q', 'after', '2026-11-12T16:11:00Z', { users: { full_name: 'Jo Park' } })] })))!
ok('nobody assigned: whoever took its photos', nobody.who.join(' | ') === 'Dana R. | Jo P.', nobody.who.join(' | '))
ok('nobody known: no names', arrivalFromRows(linkRow(arrival({ crew: [] })))!.who.length === 0)

// ── where it is ──
ok('stages: booked and on the way are waiting; started is under way; finished is done',
  [['scheduled', null], ['pending_approval', null], ['en_route', null], ['in_progress', '2026-11-12T16:00:00Z'], ['completed', '2026-11-12T16:00:00Z'], ['no_show', null]]
    .map(([s, at]) => arrivalStage(s as string, at)).join() === 'waiting,waiting,waiting,under_way,done,done')
const booked = arrivalFromRows(linkRow(arrival({ status: 'scheduled', started_at: null })))!
ok('not started: when = its booked start, and the card says nothing yet', booked.at === '2026-11-12T16:00:00+00:00' && arrivalEmptyLine(booked) === 'arrival_not_started')
ok('under way with nothing yet', arrivalEmptyLine(arrivalFromRows(linkRow(arrival({ status: 'in_progress' })))!) === 'arrival_under_way')
ok('done with nothing recorded', arrivalEmptyLine(arrivalFromRows(linkRow(arrival()))!) === 'arrival_nothing')
ok('an arrival embedded as a list still reads', arrivalFromRows([{ job_id: 'J-arr', arrival: [arrival({ job_videos: [{ id: 'v' }] })] }])?.videos === 1)

// ── the read ──
const reads = src('src/lib/jobReads.ts')
const read = reads.slice(reads.indexOf('export const arrivalPrepRead'), reads.indexOf('\n})\n', reads.indexOf('export const arrivalPrepRead')))
ok('one read, keyed per clean, by parent_job_id', read.includes('key: `arrprep:${jobId}`') && read.includes(".from('job_arrivals')") && read.includes(".eq('parent_job_id', jobId)"))
ok('every embed hinted (job_arrivals has two FKs into jobs; job_assignments two into users)',
  ['jobs!job_arrivals_job_id_fkey(', 'crew:job_assignments!job_assignments_job_id_fkey(', 'users!job_assignments_user_id_fkey(full_name)',
    'job_photos!job_photos_job_id_fkey(', 'users!job_photos_user_id_fkey(full_name)', 'job_videos!job_videos_job_id_fkey(id)'].every(h => read.includes(h)) &&
  !/[\s,(:]jobs\(/.test(read) && !/job_photos\(/.test(read))
ok('the day pack saves it for every clean', /if \(!isTask\) reads\.push\(arrivalPrepRead\(job\.id\)\)/.test(reads))
ok('the cache pruner drops it with its clean', /const JOB_KEYS = new Set\(\[[^\]]*'arrprep',/.test(reads))

// ── the card ──
const loader = src('src/lib/arrivalPrepCard.ts')
ok('the card\'s load: the saved copy after a short wait, at once after a failed request',
  /readSoon\(arrivalPrepRead\(job\.id\), lastTripFailed\(\) \? 0 : ARRIVAL_WAIT\.ms\)/.test(loader) && /!late\.fromCache && !late\.error/.test(loader))
const card = src('src/components/ArrivalPrepCard.tsx')
ok('the card makes no reads of its own', !/\b(?:cachedRead|cachedQuery|readSoon)\(|supabase\./.test(card) && /loadArrivalPrep\(job, /.test(card))
ok('thumbnails open the app\'s full-screen photo viewer', /<PhotoViewer photos=\{viewerPhotos\} startIndex=\{open\}/.test(card) && /<ShotThumb uri=\{p\.url\}/.test(card))
ok('no video player (a native module): the videos are counted', !/expo-av|expo-video|react-native-video/.test(card) && /arrival_videos/.test(card))
ok('nothing renders without an arrival', /if \(!view\) return null/.test(card))
const screen = src('src/screens/JobDetailScreen.tsx')
ok('the clean\'s screen shows it on cleans, under the inspection\'s missed lines', /<CarriedLinesCard job=\{job\} \/>\}[\s\S]{0,400}\{!isTask && <ArrivalPrepCard job=\{job\} \/>\}/.test(screen))

// ── strings ──
const i18n = src('src/lib/i18n.ts')
const KEYS = ['arrival_title', 'arrival_title_who', 'arrival_title_one', 'arrival_hint', 'arrival_before', 'arrival_after',
  'arrival_video_one', 'arrival_videos', 'arrival_not_started', 'arrival_under_way', 'arrival_nothing']
const count = (k: string) => (i18n.match(new RegExp(`\\n\\s+${k}: `, 'g')) || []).length
ok('every string in en, es and pt', KEYS.every(k => count(k) === 3), KEYS.filter(k => count(k) !== 3).join(', '))
ok('the card\'s keys are all defined', [...card.matchAll(/t\('(\w+)'\)/g)].map(m => m[1]).every(k => count(k) === 3 || ['damage', 'other_photo'].includes(k)))

// ── OTA-safe ──
const pkg = JSON.parse(src('package.json'))
ok('no package.json script for this test (scripts move the OTA fingerprint)', !Object.values(pkg.scripts || {}).some((v: any) => String(v).includes('arrival')))

console.log(failures ? `\n${failures} check(s) failed` : '\nAll arrival-prep checks pass.')
process.exit(failures ? 1 : 0)
