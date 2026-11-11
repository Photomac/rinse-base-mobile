// In-app video scenario test. Run with: node scripts/test-in-app-video.mjs
//
// Exercises the REAL src/lib/videoApi.ts (pure): which builds play a video
// inside the app and which hand it to the phone's own player. Then checks on
// the source text the rule that keeps the 1.1.5 / 1.1.6 store builds opening:
// nothing loads expo-video without first asking whether its native module is
// in the build, and the one require of it sits inside a try (so a tree
// without the package installed still bundles).
//
// Asked for by CKS Perfections (2026-11-11): the turnover crew watch the
// arrival prep's videos without leaving the app.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pickVideoApi, type VideoEnv } from '../videoApi'

let failures = 0
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const repo = process.env.RINSEBASE_MOBILE_REPO as string
const src = (p: string) => readFileSync(join(repo, p), 'utf8')

// ── which build plays where ──
const useVideoPlayer = () => ({})
const VideoView = () => null
const realModule = { useVideoPlayer, VideoView, createVideoPlayer: () => ({}) }
function run(over: Partial<VideoEnv>) {
  const calls = { hasNative: 0, load: 0 }
  const env: VideoEnv = {
    platform: 'ios',
    hasNative: () => true,
    load: () => realModule,
    ...over,
  }
  const api = pickVideoApi({
    platform: env.platform,
    hasNative: () => { calls.hasNative++; return env.hasNative() },
    load: () => { calls.load++; return env.load() },
  })
  return { api, calls }
}

{
  const { api, calls } = run({})
  ok('a build with expo-video (iOS): the player inside the app', (api?.useVideoPlayer as unknown) === useVideoPlayer && api?.VideoView === VideoView)
  ok('… asks for the native module before loading the package', calls.hasNative === 1 && calls.load === 1)
}
ok('a build with expo-video (Android): the player inside the app', run({ platform: 'android' }).api?.VideoView === VideoView)
{
  const { api, calls } = run({ hasNative: () => false })
  ok('the 1.1.5 / 1.1.6 builds (no native module): the phone\'s player', api === null)
  ok('… and the package is never loaded there (it would throw at load)', calls.load === 0)
}
{
  const { api, calls } = run({ hasNative: () => { throw new Error('TurboModuleRegistry') } })
  ok('a module check that throws: the phone\'s player, nothing loaded', api === null && calls.load === 0)
}
ok('a package that throws on load: the phone\'s player', run({ load: () => { throw new Error('Cannot find native module \'ExpoVideo\'') } }).api === null)
ok('no package in the bundle (the optional require gave nothing): the phone\'s player', run({ load: () => null }).api === null)
ok('a package without the player: the phone\'s player', run({ load: () => ({ useVideoPlayer }) }).api === null)
ok('a package whose hook isn\'t a function: the phone\'s player', run({ load: () => ({ useVideoPlayer: 1, VideoView }) }).api === null)
ok('a module check that says something other than yes: the phone\'s player', run({ hasNative: () => 'yes' as unknown as boolean }).api === null)
{
  const { api, calls } = run({ platform: 'web' })
  ok('the web export (screenshot harness): the browser, nothing asked or loaded', api === null && calls.hasNative === 0 && calls.load === 0)
}

// ── nothing loads expo-video on a build without it ──
const files: string[] = []
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p) }
    else if (/\.(tsx?|jsx?)$/.test(name)) files.push(p)
  }
}
walk(join(repo, 'src'))
for (const f of ['App.tsx', 'index.ts']) if (existsSync(join(repo, f))) files.push(join(repo, f))
const mentions = files.filter(f => /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|^\s*import\s+)['"]expo-video(?:\/[^'"]*)?['"]/m.test(readFileSync(f, 'utf8')))
  .map(f => relative(repo, f))
ok('only lib/inAppVideo.ts names the package (no import, not even a type import)', mentions.length === 1 && mentions[0] === 'src/lib/inAppVideo.ts', mentions.join(', '))
const iav = src('src/lib/inAppVideo.ts')
ok('… as a require directly inside a try (Metro bundles a tree without the package)',
  /try\s*\{\s*return require\('expo-video'\)\s*\}\s*catch\s*\{\s*return null\s*\}/.test(iav) && !/\bfrom\s*'expo-video'/.test(iav))
ok('… only after asking for the native module', /hasNative: \(\) => requireOptionalNativeModule\('ExpoVideo'\) != null/.test(iav) && /pickVideoApi\(\{/.test(iav))
ok('… and asks once (the answer is kept)', /if \(api === undefined\)/.test(iav))
ok('no other video module anywhere', !files.some(f => /(?:from|require\()\s*['"](?:expo-av|react-native-video|react-native-webview)['"]/.test(readFileSync(f, 'utf8'))))

// ── the player ──
const modal = src('src/components/VideoPlayerModal.tsx')
ok('the player renders nothing without the in-app player', /const api = inAppVideo\(\)/.test(modal) && /if \(!api \|\| !video\) return null/.test(modal))
ok('… no hook after that return (Rules of Hooks)', (() => {
  const body = modal.slice(modal.indexOf('export function VideoPlayerModal'), modal.indexOf('function VideoStage'))
  const after = body.slice(body.indexOf('if (!api || !video) return null'))
  return !/\buse[A-Z]\w*\(/.test(after)
})())
ok('the phone\'s own controls play, pause and scrub', /<api\.VideoView player=\{player\}[^>]*\bnativeControls\b/.test(modal))
ok('one player per video: paging remounts the stage', /<VideoStage key=\{`\$\{index\}:\$\{video\.url\}`\}/.test(modal) && /api\.useVideoPlayer\(\{ uri: url \}, p => p\.play\(\)\)/.test(modal))
ok('‹ › only with more than one video, and they wrap', /\{many && \(/.test(modal) && /\(i \+ dir \+ videos\.length\) % videos\.length/.test(modal))
ok('close: the ✕ and the Android back button', /onRequestClose=\{onClose\}/.test(modal) && /testID="video-player-close"/.test(modal))
ok('on an error the native view goes, so its own "can\'t play" glyph doesn\'t show through the message',
  /\{status !== 'error' && \(\s*<api\.VideoView /.test(modal))
ok('a video that won\'t play here offers the phone\'s player (https only)',
  /status === 'error'/.test(modal) && /Linking\.openURL\(url\)\.catch\(\(\) => Alert\.alert\(t\('arrival_video_failed'\)\)\)/.test(modal) && /const outside = \/\^https:/.test(modal))

// ── the arrival prep card ──
const card = src('src/components/ArrivalPrepCard.tsx')
ok('the card plays in the app when it can', /const inApp = inAppVideo\(\) != null/.test(card) && /if \(inApp\) \{ setPlaying\(view\.videos\.indexOf\(v\)\); return \}/.test(card) && /<VideoPlayerModal/.test(card))
ok('… and otherwise in the phone\'s player, exactly as on 1.1.5 / 1.1.6', /Linking\.openURL\(v\.url\)\.catch\(\(\) => Alert\.alert\(t\('arrival_video_failed'\)\)\)/.test(card))
ok('the hint under the videos says which', /\{inApp \? t\('arrival_video_hint_app'\) : t\('arrival_video_hint'\)\}/.test(card))
ok('a newer answer with a different number of videos closes the player', /useEffect\(\(\) => \{ setPlaying\(null\) \}, \[videoCount\]\)/.test(card))

// ── strings ──
const i18n = src('src/lib/i18n.ts')
const KEYS = ['arrival_video_hint_app', 'video_close', 'video_prev', 'video_next', 'video_cant_play', 'video_open_phone']
const count = (k: string) => (i18n.match(new RegExp(`\\n\\s+${k}: `, 'g')) || []).length
ok('every string in en, es and pt', KEYS.every(k => count(k) === 3), KEYS.filter(k => count(k) !== 3).join(', '))
ok('the player\'s keys are all defined', [...modal.matchAll(/t\('(\w+)'\)/g)].map(m => m[1]).every(k => count(k) === 3))

// ── the native side, and the OTA rules ──
const pkg = JSON.parse(src('package.json'))
ok('expo-video at the SDK 54 pin', /^~3\.0\.\d+$/.test(pkg.dependencies?.['expo-video'] ?? ''), pkg.dependencies?.['expo-video'])
ok('no new package.json script (scripts move the OTA fingerprint)', JSON.stringify(Object.keys(pkg.scripts || {}).sort()) === JSON.stringify(['android', 'ios', 'start', 'web']))
const appJson = JSON.parse(src('app.json'))
ok('no expo-video config plugin (a no-op without options; app.json stays as it was)',
  !(appJson.expo?.plugins || []).some((p: unknown) => (Array.isArray(p) ? p[0] : p) === 'expo-video'))
ok('no committed metro.config.js', !existsSync(join(repo, 'metro.config.js')))

console.log(failures ? `\n${failures} check(s) failed` : '\nAll in-app video checks pass.')
process.exit(failures ? 1 : 0)
