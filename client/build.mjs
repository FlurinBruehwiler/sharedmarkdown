// Bundles the frontend into ../dist: one hashed (cache-forever) JS file, CSS inlined into index.html.
import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'

const out = '../dist'
fs.rmSync(out, { recursive: true, force: true })

const result = await esbuild.build({
  entryPoints: ['src/main.js'],
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
console.log(`js ${(fs.statSync(js).size / 1024).toFixed(1)} KiB, html ${(html.length / 1024).toFixed(1)} KiB`)
