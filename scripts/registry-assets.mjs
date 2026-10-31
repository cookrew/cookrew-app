// Generates registry/src/assets-bundle.ts from registry/assets/{vendor,*.js,*.css}.
//
// The registry ships as ONE esbuild bundle (a ConfigMap on the cluster, a
// single file under systemd), so anything it serves as a static asset has to
// travel inside that bundle. This turns the vendored xterm.js, the site's own
// scripts and their stylesheets into string constants; the bundle build runs
// it first (`npm run registry:build`), and the generated file is committed so
// tests and type-checks see the same bytes production serves.
//
// THE SECOND BUNDLE (strata, D3): `--shell <built dir> [--shell-out <file>]`
// packs the Strata shell's build (index.html + assets/, built with base
// /strata/) into ONE JSON file for a second ConfigMap, which the registry
// reads at boot with --shell-assets (registry/src/strata-shell.ts). It is a
// build output, never committed, and it never touches assets-bundle.ts.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assets = path.join(root, 'registry', 'assets')

const argOf = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : null
}

/** A ConfigMap holds at most 1 MiB of data; leave room for its own envelope. */
const SHELL_MAX_BYTES = 1_000_000
const SHELL_WARN_BYTES = 900_000
const SHELL_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': ['image/png', 'base64'],
  '.webp': ['image/webp', 'base64'],
  '.woff2': ['font/woff2', 'base64'],
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8'
}

const walk = (dir, prefix = '') =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    return statSync(full).isDirectory() ? walk(full, rel) : [rel]
  })

function packShell(builtDir, outFile) {
  const index = readFileSync(path.join(builtDir, 'index.html'), 'utf8')
  // Built with the default base, the shell would ask for /assets/…, which is
  // the registry's OWN asset route: refuse rather than ship a blank page.
  if (/(?:src|href)="\/assets\//.test(index)) {
    throw new Error('index.html references /assets/ — build the shell with base /strata/ (vite build --base /strata/)')
  }
  const files = {}
  for (const rel of walk(builtDir)) {
    if (rel === 'index.html') continue
    const kind = SHELL_TYPES[path.extname(rel).toLowerCase()]
    if (!kind) throw new Error(`no content type for ${rel}; add it to SHELL_TYPES`)
    const [type, encoding] = Array.isArray(kind) ? kind : [kind]
    const bytes = readFileSync(path.join(builtDir, rel))
    files[rel] = encoding === 'base64' ? { type, body: bytes.toString('base64'), encoding } : { type, body: bytes.toString('utf8') }
  }
  const version = createHash('sha256').update(index).update(JSON.stringify(files)).digest('hex').slice(0, 12)
  const out = JSON.stringify({ version, index, files })
  if (out.length > SHELL_MAX_BYTES) throw new Error(`shell bundle is ${out.length} bytes, over the ConfigMap's ${SHELL_MAX_BYTES}`)
  writeFileSync(outFile, out)
  const warn = out.length > SHELL_WARN_BYTES ? ' — WARNING: near the 1 MiB ConfigMap ceiling' : ''
  console.log(`${outFile}: ${Object.keys(files).length + 1} files, ${(out.length / 1024).toFixed(0)} KB${warn}`)
}

const shellDir = argOf('shell')
if (shellDir) {
  packShell(path.resolve(shellDir), path.resolve(argOf('shell-out') ?? '/tmp/strata-shell-assets.json'))
  process.exit(0)
}

/** name on the wire → source file, content type. */
const FILES = [
  ['xterm.js', 'vendor/xterm.js.txt', 'text/javascript; charset=utf-8'],
  ['xterm.css', 'vendor/xterm.css.txt', 'text/css; charset=utf-8'],
  ['addon-fit.js', 'vendor/addon-fit.js.txt', 'text/javascript; charset=utf-8'],
  ['device-id.js', 'device-id.js', 'text/javascript; charset=utf-8'],
  ['site.js', 'site.js', 'text/javascript; charset=utf-8'],
  ['device-seal.js', 'device-seal.js', 'text/javascript; charset=utf-8'],
  ['reach.js', 'reach.js', 'text/javascript; charset=utf-8'],
  ['factors.js', 'factors.js', 'text/javascript; charset=utf-8'],
  ['seal.js', 'seal.js', 'text/javascript; charset=utf-8'],
  ['line.js', 'line.js', 'text/javascript; charset=utf-8'],
  ['inter.woff2', 'fonts/inter.woff2', 'font/woff2', 'base64'],
  ['jetbrains-mono.woff2', 'fonts/jetbrains-mono.woff2', 'font/woff2', 'base64'],
]

const entries = FILES.map(([name, file, type, encoding]) => {
  const body = encoding === 'base64' ? readFileSync(path.join(assets, file)).toString('base64') : readFileSync(path.join(assets, file), 'utf8')
  return `  ${JSON.stringify(name)}: { type: ${JSON.stringify(type)}, body: ${JSON.stringify(body)}${encoding === 'base64' ? ", encoding: 'base64'" : ''} }`
})

const version = createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 12)
const out = `// GENERATED by scripts/registry-assets.mjs — do not edit. Sources: registry/assets/.
/** A content hash of every asset: pages link /assets/x?v=… so a new bundle is never a stale script. */
export const ASSET_VERSION = ${JSON.stringify(version)}

export interface BundledAsset {
  type: string
  body: string
  /** Binary assets travel as base64; text ones as they are. */
  encoding?: 'base64'
}

export const ASSETS: Readonly<Record<string, BundledAsset>> = {
${entries.join(',\n')}
}
`
writeFileSync(path.join(root, 'registry', 'src', 'assets-bundle.ts'), out)
console.log(`assets-bundle.ts: ${FILES.length} files, ${(out.length / 1024).toFixed(0)} KB`)
