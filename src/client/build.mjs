// Bundles the frontend into ../SharedMarkdown/dist: one hashed (cache-forever) JS file, CSS inlined into index.html,
// and the service worker (sw.js).
import * as esbuild from 'esbuild'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Type-check first: esbuild only strips types, so a type error would otherwise ship.
try { execSync('npx tsc -p .', { stdio: 'inherit' }) } catch { process.exit(1) }

// Output goes into the server project, which serves it (see Assets.cs).
const out = '../SharedMarkdown/dist'
fs.rmSync(out, { recursive: true, force: true })

const result = await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2022',
  outdir: out + '/assets',
  entryNames: '[name]-[hash]',
  legalComments: 'none',
  metafile: true,
})
const js = Object.keys(result.metafile.outputs).find(f => f.endsWith('.js'))
const css = (await esbuild.transform(fs.readFileSync('src/style.css', 'utf8'), { loader: 'css', minify: true })).code.trim()
const html = fs.readFileSync('index.html', 'utf8')
  .replace(/>\s+</g, '><')
  .replace('/*CSS*/', () => css)
  .replace('/*JS*/', '/assets/' + path.basename(js))
fs.writeFileSync(out + '/index.html', html)

// The service worker: its own entry, at the site root (its scope) and not hashed, so browsers find
// new versions at the same URL. The bundle name is baked in: each deploy changes sw.js and replaces the cache.
await esbuild.build({
  entryPoints: ['src/sw.ts'],
  bundle: true,
  minify: true,
  format: 'iife', // registered as a classic worker script
  target: 'es2022',
  outfile: out + '/sw.js',
  legalComments: 'none',
  define: { __BUILD__: JSON.stringify('/assets/' + path.basename(js)) },
})
console.log(`js ${(fs.statSync(js).size / 1024).toFixed(1)} KiB, html ${(html.length / 1024).toFixed(1)} KiB`)
