// Arrival-prep scenario test. Run with: node scripts/test-arrival-prep.mjs
//
// Exercises the REAL src/lib/arrivalPrep.ts (pure): the read's rows → the
// "From the arrival prep" card on a turnover. Then checks the wiring on the
// source text: the one read and its hinted embeds, the day pack and the cache
// pruner knowing its key, the card making no reads of its own, opening the
// app's photo viewer and handing a video to the phone's own player, the screen
// mounting it on cleans, and every string in all three languages.
//
// Asked for by CKS Perfections (2026-11-11): the arrival prep films and
// photographs how the guest left the home; by the time the turnover crew get
// there that state is gone, so it belongs with the clean.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { arrivalFromRows, arrivalGroupOf, arrivalPhotoGroups, arrivalEmptyLine, arrivalStage, playableVideoUrl, videoLength } from '../arrivalPrep'

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
const VURL = (n: string) => `https://cbnbhwclbtowfbjylnph.supabase.co/storage/v1/object/public/job-videos/t-cks/J-arr/${n}.mp4`
const video = (id: string, type: string | null, at: string, extra: Record<string, unknown> = {}) => ({
  id, video_url: VURL(id), video_type: type, caption: null, duration_seconds: 42, recorded_at: at, created_at: at, users: { full_name: 'Dana Reyes' }, ...extra,
})
// As PostgREST returns arrivalPrepRead: job_arrivals rows, the arrival embedded
// one-to-one (an object), its crew, photos and videos.
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
const calledOffWithVideo = arrivalFromRows(linkRow(arrival({ status: 'cancelled', job_videos: [video('v1', 'before', '2026-11-12T16:08:00Z')] })))
ok('…but one called off after it filmed: shown', calledOffWithVideo?.videos.length === 1)
ok('…and one whose only video has no file: no card', arrivalFromRows(linkRow(arrival({ status: 'cancelled', job_videos: [video('v1', 'before', '2026-11-12T16:08:00Z', { video_url: null })] }))) === null)

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
  job_videos: [
    video('vafter', 'after', '2026-11-12T16:41:00Z', { duration_seconds: 65 }),
    video('vline', 'line', '2026-11-12T16:25:00Z', { caption: 'Fridge door seal', duration_seconds: null }),
    video('vbefore', 'before', '2026-11-12T16:08:00Z', { duration_seconds: 120, users: [{ full_name: 'Sam Ortiz' }] }),
    video('vnofile', 'before', '2026-11-12T16:09:00Z', { video_url: '' }),
    video('vscheme', 'before', '2026-11-12T16:10:00Z', { video_url: 'tel:911' }),
    null,
  ],
})))!
ok('every photo with a url, none without', full.photos.length === 5, String(full.photos.length))
ok('in the card\'s order: as the guest left it, damage, other, after the prep; oldest first within (taken, else saved)',
  full.photos.map(p => p.id).join() === 'b1,b2,dmg,gen,after1', full.photos.map(p => p.id).join())
ok('the caption trimmed, who took it short', full.photos[2].caption === 'Wine on the rug' && full.photos[2].by === 'Dana R.')
ok('the groups that have photos, in order', arrivalPhotoGroups(full.photos).map(g => `${g.group}:${g.photos.length}`).join() === 'before:2,damage:1,other:1,after:1')
ok('every video with an https file, none without (no file, a tel: link)', full.videos.length === 3, full.videos.map(v => v.id).join())
ok('videos in the same order: as the guest left it, other, after the prep',
  full.videos.map(v => `${v.id}:${v.group}`).join() === 'vbefore:before,vline:other,vafter:after', full.videos.map(v => `${v.id}:${v.group}`).join())
ok('each video: its file, length, who filmed it, when, its caption',
  full.videos[0].url === VURL('vbefore') && full.videos[0].secs === 120 && full.videos[0].by === 'Sam O.' && full.videos[0].at === '2026-11-12T16:08:00Z' &&
  full.videos[1].caption === 'Fridge door seal' && full.videos[1].secs === null)
ok('a video\'s length reads as m:ss', [42, 65, 120, 0, 59.6].map(videoLength).join() === '0:42,1:05,2:00,0:00,1:00' && videoLength(null) === null && videoLength(-3) === null && videoLength(NaN) === null)
ok('only a plain https link is handed to the phone',
  playableVideoUrl(VURL('x')) === VURL('x') && [null, '', 'http://x.test/a.mp4', 'tel:911', 'sms:1', 'javascript:alert(1)', 'rinsebase://job/1', 'https://a b'].every(u => playableVideoUrl(u) === null))
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
ok('nobody assigned and only a video: whoever filmed it', arrivalFromRows(linkRow(arrival({ crew: [], job_videos: [video('v', 'before', '2026-11-12T16:08:00Z')] })))!.who.join() === 'Dana R.')

// ── where it is ──
ok('stages: booked and on the way are waiting; started is under way; finished is done',
  [['scheduled', null], ['pending_approval', null], ['en_route', null], ['in_progress', '2026-11-12T16:00:00Z'], ['completed', '2026-11-12T16:00:00Z'], ['no_show', null]]
    .map(([s, at]) => arrivalStage(s as string, at)).join() === 'waiting,waiting,waiting,under_way,done,done')
const booked = arrivalFromRows(linkRow(arrival({ status: 'scheduled', started_at: null })))!
ok('not started: when = its booked start, and the card says nothing yet', booked.at === '2026-11-12T16:00:00+00:00' && arrivalEmptyLine(booked) === 'arrival_not_started')
ok('under way with nothing yet', arrivalEmptyLine(arrivalFromRows(linkRow(arrival({ status: 'in_progress' })))!) === 'arrival_under_way')
ok('done with nothing recorded', arrivalEmptyLine(arrivalFromRows(linkRow(arrival()))!) === 'arrival_nothing')
ok('an arrival embedded as a list still reads', arrivalFromRows([{ job_id: 'J-arr', arrival: [arrival({ job_videos: [video('v', 'before', '2026-11-12T16:08:00Z')] })] }])?.videos.length === 1)
ok('a video on its own says nothing empty', arrivalEmptyLine(arrivalFromRows(linkRow(arrival({ job_videos: [video('v', 'before', '2026-11-12T16:08:00Z')] })))!) === null)

// ── the read ──
const reads = src('src/lib/jobReads.ts')
const read = reads.slice(reads.indexOf('export const arrivalPrepRead'), reads.indexOf('\n})\n', reads.indexOf('export const arrivalPrepRead')))
ok('one read, keyed per clean, by parent_job_id', read.includes('key: `arrprep:${jobId}`') && read.includes(".from('job_arrivals')") && read.includes(".eq('parent_job_id', jobId)"))
ok('every embed hinted (job_arrivals has two FKs into jobs; job_assignments two into users)',
  ['jobs!job_arrivals_job_id_fkey(', 'crew:job_assignments!job_assignments_job_id_fkey(', 'users!job_assignments_user_id_fkey(full_name)',
    'job_photos!job_photos_job_id_fkey(', 'users!job_photos_user_id_fkey(full_name)',
    'job_videos!job_videos_job_id_fkey(id, video_url, video_type, caption, duration_seconds, recorded_at, created_at, users!job_videos_user_id_fkey(full_name))'].every(h => read.includes(h)) &&
  !/[\s,(:]jobs\(/.test(read) && !/job_photos\(/.test(read) && !/job_videos\(/.test(read))
ok('the day pack saves it for every clean', /if \(!isTask\) reads\.push\(arrivalPrepRead\(job\.id\)\)/.test(reads))
ok('the cache pruner drops it with its clean', /const JOB_KEYS = new Set\(\[[^\]]*'arrprep',/.test(reads))

// ── the card ──
const loader = src('src/lib/arrivalPrepCard.ts')
ok('the card\'s load: the saved copy after a short wait, at once after a failed request',
  /readSoon\(arrivalPrepRead\(job\.id\), lastTripFailed\(\) \? 0 : ARRIVAL_WAIT\.ms\)/.test(loader) && /!late\.fromCache && !late\.error/.test(loader))
const card = src('src/components/ArrivalPrepCard.tsx')
ok('the card makes no reads of its own', !/\b(?:cachedRead|cachedQuery|readSoon)\(|supabase\./.test(card) && /loadArrivalPrep\(job, /.test(card))
ok('thumbnails open the app\'s full-screen photo viewer', /<PhotoViewer photos=\{viewerPhotos\} startIndex=\{open\}/.test(card) && /<ShotThumb uri=\{p\.url\}/.test(card))
ok('the card loads no video module itself; without the in-app player a tap opens the phone\'s player (scripts/test-in-app-video.mjs)',
  !/(?:from|require\()\s*'(?:expo-av|expo-video|react-native-video|react-native-webview)'/.test(card) && /Linking\.openURL\(v\.url\)\.catch\(\(\) => Alert\.alert\(t\('arrival_video_failed'\)\)\)/.test(card) && /onPress=\{\(\) => play\(v\)\}/.test(card))
ok('the only video module is expo-video (the in-app player, store builds from 1.1.7)', (() => {
  const deps = JSON.parse(src('package.json')).dependencies || {}
  return 'expo-video' in deps && !['expo-av', 'react-native-video', 'react-native-webview'].some(m => m in deps)
})())
ok('nothing renders without an arrival', /if \(!view\) return null/.test(card))
const screen = src('src/screens/JobDetailScreen.tsx')
ok('the clean\'s screen shows it on cleans, under the inspection\'s missed lines', /<CarriedLinesCard job=\{job\} \/>\}[\s\S]{0,400}\{!isTask && <ArrivalPrepCard job=\{job\} \/>\}/.test(screen))

// ── strings ──
const i18n = src('src/lib/i18n.ts')
const KEYS = ['arrival_title', 'arrival_title_who', 'arrival_title_one', 'arrival_hint', 'arrival_before', 'arrival_after',
  'arrival_videos_head', 'arrival_video_play', 'arrival_video_hint', 'arrival_video_failed', 'arrival_not_started', 'arrival_under_way', 'arrival_nothing']
const count = (k: string) => (i18n.match(new RegExp(`\\n\\s+${k}: `, 'g')) || []).length
ok('every string in en, es and pt', KEYS.every(k => count(k) === 3), KEYS.filter(k => count(k) !== 3).join(', '))
ok('no string still sends crew to the web for the videos', !/arrival_videos?: '[^']*(web|Photos tab|pestaña Photos|aba Photos)/.test(i18n) && count('arrival_video_one') === 0)
ok('the card\'s keys are all defined', [...card.matchAll(/t\('(\w+)'\)/g)].map(m => m[1]).every(k => count(k) === 3 || ['damage', 'other_photo'].includes(k)))

// ── OTA-safe ──
const pkg = JSON.parse(src('package.json'))
ok('no package.json script for this test (scripts move the OTA fingerprint)', !Object.values(pkg.scripts || {}).some((v: any) => String(v).includes('arrival')))

console.log(failures ? `\n${failures} check(s) failed` : '\nAll arrival-prep checks pass.')
process.exit(failures ? 1 : 0)
