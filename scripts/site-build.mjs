// cookrew.dev AS FILES (0.6.0): writes the static site to out/site.
//
// The pages are made by registry/src/site-static.ts, which is pure; this is
// the part that reads the world and writes a disk. It bundles that module,
// asks GitHub which release the download buttons should name, hands it the
// fonts, and writes what it answers. Nothing here deploys anything; CI uploads
// the directory.
//
//   --out <dir>                       where to write (default: out/site)
//   COOKREW_CONSOLE_ORIGIN            where "your machines" are   (default: production)
//   COOKREW_AUTH_ORIGIN               where the account is        (default: production)
//   COOKREW_SITE_RELEASE=v0.6.0       the release to name (default: the latest published)
//   COOKREW_SITE_REQUIRE_RELEASE=1    stop unless that release and its Mac build can be read (CI)
//   COOKREW_SITE_OFFLINE=1            ask GitHub nothing: no release named, no commit list
//   COOKREW_SITE_REF=<commit>         the commit the pictures are read at (default: HEAD)
//   GITHUB_TOKEN                      sent to api.github.com, and nowhere else, when set
//
// THE PICTURES ARE NOT IN THE OUTPUT. The pages name them on
// raw.githubusercontent.com at one commit, as they always have, so that commit
// has to be on GitHub by the time the site is: build from the release tag.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const env = process.env
const flag = (name) => env[name] === '1'

/** What the build needs from the registry's sources, as one module. */
const ENTRY = `
export { buildStaticSite } from './site-static'
export { parseRelease, pickAsset, RELEASES_API } from './releases'
export { parseCommits, COMMITS_API } from './github-commits'
export { SITE_FRAMES } from './site-shell'
`

function outDir() {
  const at = process.argv.indexOf('--out')
  const named = at === -1 ? null : process.argv[at + 1]
  if (at !== -1 && !named) throw new Error('--out needs a directory')
  return path.resolve(root, named ?? 'out/site')
}

function siteRef() {
  const ref = env.COOKREW_SITE_REF ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`the commit the pictures are read at must be a full commit id (got ${JSON.stringify(ref)})`)
  return ref
}

async function generator(ref) {
  const bundled = await build({
    stdin: { contents: ENTRY, resolveDir: path.join(root, 'registry/src'), loader: 'ts', sourcefile: 'site-build-entry.ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    define: { __SITE_REF__: JSON.stringify(ref) }
  })
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cookrew-site-generator-'))
  try {
    const file = path.join(dir, 'generator.mjs')
    writeFileSync(file, bundled.outputFiles[0].contents)
    return await import(pathToFileURL(file).href)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** One question to GitHub's API. The address is one of ours; the token goes nowhere else. */
async function github(url) {
  if (!url.startsWith('https://api.github.com/')) throw new Error(`not a GitHub API address: ${url}`)
  const token = env.GITHUB_TOKEN
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'cookrew-site-build', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  return res.json()
}

/** The release the buttons name, or null with the reason said. A required release that is not there stops the build. */
async function readRelease(site) {
  const tag = env.COOKREW_SITE_RELEASE
  if (tag !== undefined && !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(tag)) throw new Error(`COOKREW_SITE_RELEASE must be a tag like v0.6.0 (got ${JSON.stringify(tag)})`)
  const required = flag('COOKREW_SITE_REQUIRE_RELEASE')
  const none = (why) => {
    if (required) throw new Error(`a release is required and ${why}`)
    process.stdout.write(`site: no release is named (${why}); the buttons point at the releases page\n`)
    return null
  }
  if (flag('COOKREW_SITE_OFFLINE')) return none('the build is offline')
  let release
  try {
    release = site.parseRelease(await github(tag ? site.RELEASES_API.replace(/latest$/, `tags/${tag}`) : site.RELEASES_API))
  } catch (error) {
    return none(`GitHub could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!release) return none('GitHub answered something that is not a release')
  if (!site.pickAsset(release, 'mac')) return none(`${release.tag} has no Mac build yet`)
  return release
}

async function readCommits(site) {
  if (flag('COOKREW_SITE_OFFLINE')) return null
  try {
    return site.parseCommits(await github(site.COMMITS_API))
  } catch (error) {
    process.stdout.write(`site: no commit list (${error instanceof Error ? error.message : String(error)})\n`)
    return null
  }
}

function fonts() {
  const dir = path.join(root, 'registry/assets/fonts')
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith('.woff2'))
      .map((name) => [name, new Uint8Array(readFileSync(path.join(dir, name)))])
  )
}

/** Every picture and film a page names has to be a file of the repository at that commit. */
function missingMedia(files, frames) {
  const dir = path.join(root, 'registry/assets/site')
  const named = new Set()
  for (const body of files.values()) {
    if (typeof body !== 'string') continue
    for (let at = body.indexOf(frames); at !== -1; at = body.indexOf(frames, at + 1)) {
      const name = /^[A-Za-z0-9._-]+/.exec(body.slice(at + frames.length))
      if (name) named.add(name[0])
    }
  }
  return [...named].filter((name) => !existsSync(path.join(dir, name)))
}

/**
 * The directory, emptied, when it is empty already or a build made it. A
 * directory holding anything else is somebody's, and the build stops.
 */
function cleared(out) {
  if (existsSync(out)) {
    const held = readdirSync(out)
    if (held.length > 0 && !(held.includes('_headers') && held.includes('index.html'))) {
      throw new Error(`${out} holds files this build did not make; it is left alone`)
    }
    rmSync(out, { recursive: true })
  }
  mkdirSync(out, { recursive: true })
  return out
}

function write(out, files) {
  let bytes = 0
  for (const [name, body] of files) {
    const target = path.resolve(out, name)
    if (!target.startsWith(out + path.sep)) throw new Error(`a file of the site would be written outside it: ${name}`)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, body)
    bytes += typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength
  }
  return bytes
}

async function main() {
  const out = outDir()
  const ref = siteRef()
  const site = await generator(ref)
  const [release, commits] = await Promise.all([readRelease(site), readCommits(site)])
  const files = site.buildStaticSite({
    release,
    commits,
    console: env.COOKREW_CONSOLE_ORIGIN ?? 'https://console.cookrew.dev',
    auth: env.COOKREW_AUTH_ORIGIN ?? 'https://auth.cookrew.dev',
    fonts: fonts()
  })
  const missing = missingMedia(files, site.SITE_FRAMES)
  if (missing.length > 0) throw new Error(`the pages name files that are not in registry/assets/site: ${missing.join(', ')}`)
  const bytes = write(cleared(out), files)
  process.stdout.write(`site: ${files.size} files, ${Math.round(bytes / 1024)} KB in ${path.relative(root, out) || out}; ${release ? `names ${release.tag}` : 'names no release'}; pictures at ${ref.slice(0, 12)}\n`)
}

main().catch((error) => {
  process.stderr.write(`site build failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
