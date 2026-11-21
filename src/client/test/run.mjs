// `npm test`: bundles every test/*.test.ts for node (esbuild) and runs them with node:test.
import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

const dir = new URL('.', import.meta.url).pathname
const tests = fs.readdirSync(dir).filter(f => f.endsWith('.test.ts')).sort()
fs.rmSync(dir + '.out', { recursive: true, force: true })
await esbuild.build({
  entryPoints: tests.map(f => dir + f),
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: dir + '.out',
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
})
const files = tests.map(f => dir + '.out/' + f.replace(/\.ts$/, '.mjs'))
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
process.exit(r.status ?? 1)
