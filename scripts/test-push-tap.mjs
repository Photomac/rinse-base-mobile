#!/usr/bin/env node
// Runs the push-tap scenario test (src/lib/__tests__/pushTap.scenario.ts)
// against the REAL src/lib/pushTap.ts and the jobScope.ts it imports. Both are
// pure, so this bundles them with esbuild (fetched on demand via npx, as the
// other runners do) and runs the result; the scenario also reads App.tsx and
// the screens' source text, copied next to it.
//
// No package.json script on purpose: scripts are an OTA fingerprint input.
//
// Usage: node scripts/test-push-tap.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'push-tap-test-'))

try {
  cpSync(join(repo, 'src'), join(work, 'src'), { recursive: true })
  cpSync(join(repo, 'App.tsx'), join(work, 'App.tsx'))
  writeFileSync(join(work, 'scenario.ts'),
    readFileSync(join(repo, 'src/lib/__tests__/pushTap.scenario.ts'), 'utf8')
      .replace(`from '../pushTap'`, `from './src/lib/pushTap'`))
  execSync('npx --yes esbuild scenario.ts --bundle --format=cjs --platform=node --outfile=out/scenario.js', {
    cwd: work, stdio: ['ignore', 'ignore', 'inherit'],
  })
  execSync('node out/scenario.js', { cwd: work, stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
