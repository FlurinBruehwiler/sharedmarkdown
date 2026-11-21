// Builds the frontend into the server project (../SharedMarkdown):
// - wwwroot/assets/app.js   the bundle; ASP.NET's MapStaticAssets fingerprints, compresses and caches it
// - wwwroot/sw.js           the service worker, at the site root (its scope), never fingerprinted
// - app.html                the page, with the CSS inlined; served by AppShell.cs for every document URL
// - wwwroot/*               public/: robots.txt, sitemap.xml, icons and the link preview image
import * as esbuild from 'esbuild'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'

// Type-check first: esbuild only strips types, so a type error would otherwise ship.
try { execSync('npx tsc -p .', { stdio: 'inherit' }) } catch { process.exit(1) }

const server = '../SharedMarkdown'
fs.mkdirSync(server + '/wwwroot/assets', { recursive: true })
fs.cpSync('public', server + '/wwwroot', { recursive: true })

const app = server + '/wwwroot/assets/app.js'
await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2022',
  outfile: app,
  legalComments: 'none',
})

const css = (await esbuild.transform(fs.readFileSync('src/style.css', 'utf8'), { loader: 'css', minify: true })).code.trim()
const html = fs.readFileSync('index.html', 'utf8')
  .replace(/<!--.*?-->/gs, '')
  .replace(/>\s+</g, '><')
  .replace('/*CSS*/', () => css)
fs.writeFileSync(server + '/app.html', html)

// The service worker names its cache after this build, so every deploy changes sw.js and replaces the cache.
const build = createHash('sha256').update(fs.readFileSync(app)).update(html).digest('hex').slice(0, 12)
await esbuild.build({
  entryPoints: ['src/sw.ts'],
  bundle: true,
  minify: true,
  format: 'iife', // registered as a classic worker script
  target: 'es2022',
  outfile: server + '/wwwroot/sw.js',
  legalComments: 'none',
  define: { __BUILD__: JSON.stringify(build) },
})
console.log(`js ${(fs.statSync(app).size / 1024).toFixed(1)} KiB, html ${(html.length / 1024).toFixed(1)} KiB`)
