#!/usr/bin/env node
// Runs the in-app video scenario test (src/lib/__tests__/inAppVideo.scenario.ts)
// against the REAL src/lib/videoApi.ts: when the crew app plays a video inside
// the app (expo-video, store builds from 1.1.7) and when it hands the video to
// the phone's own player (the 1.1.5 / 1.1.6 builds, which have no video
// module). The module is pure, so this bundles it with esbuild (fetched on
// demand via npx) and runs it; the scenario also checks on the source text
// that nothing can load expo-video on a build without it.
//
// No package.json script on purpose: scripts are an OTA fingerprint input.
//
// Usage: node scripts/test-in-app-video.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'in-app-video-test-'))

try {
  const out = join(work, 'scenario.js')
  execSync(`npx --yes esbuild ${JSON.stringify(join(repo, 'src/lib/__tests__/inAppVideo.scenario.ts'))} --bundle --platform=node --format=cjs --log-level=error --outfile=${JSON.stringify(out)}`, {
    cwd: repo, stdio: ['ignore', 'ignore', 'inherit'],
  })
  execSync(`node ${JSON.stringify(out)}`, { cwd: repo, stdio: 'inherit', env: { ...process.env, RINSEBASE_MOBILE_REPO: repo } })
} finally {
  rmSync(work, { recursive: true, force: true })
}
