// cookrew.dev AS FILES (0.6.0): writes the static site to out/site.
//
// The pages are made by registry/src/site-static.ts, which is pure; this is
// the part that reads the world and writes a disk. It bundles that module,
// asks GitHub which release the download buttons should name, hands it the
// fonts, and writes what it answers. Nothing here deploys anything; CI uploads
// the directory.
//
//   --out <dir>                       where to write (default: out/site in the repository)
//   COOKREW_CONSOLE_ORIGIN            where "your machines" are   (default: production)
//   COOKREW_AUTH_ORIGIN               where the account is        (default: production)
//   COOKREW_SITE_RELEASE=v0.6.0       the release to name (default: the latest published).
//                                     A release asked for by name has to be readable, or the build stops.
//   COOKREW_SITE_REQUIRE_RELEASE=1    stop unless a release and its Mac build can be read (CI)
//   COOKREW_SITE_OFFLINE=1            ask GitHub nothing: no release named, no commit list
//   COOKREW_SITE_REF=<commit>         the commit the pictures are read at (default: HEAD)
//   GITHUB_TOKEN                      sent to api.github.com, and nowhere else, when set
//
// THE PICTURES ARE NOT IN THE OUTPUT. The pages name them on
// raw.githubusercontent.com at one commit, as they always have, so that commit
// has to be on GitHub by the time the site is: build from the release tag.
// What is checked here is that the commit holds every picture a page names;
// that the commit is on GitHub is the tag's doing.
//
// THE SNAPSHOT. The buttons name the release read at build time, so the site
// is built again for every release.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const env = process.env

/** A switch is 1, 0 or absent. Anything else stops the build: a gate must not be left off by a spelling. */
function flag(name) {
  const value = env[name]
  if (value === undefined || value === '' || value === '0') return false
  if (value === '1') return true
  throw new Error(`${name} is 1 or 0 (got ${JSON.stringify(value)})`)
}

/** What the build needs from the registry's sources, as one module. */
const ENTRY = `
export { buildStaticSite, believedRelease, siteFonts, STATIC_SITE_MARK } from './site-static'
export { parseRelease, pickAsset, RELEASES_API } from './releases'
export { parseCommits, COMMITS_API } from './github-commits'
export { SITE_FRAMES } from './site-shell'
`

/** Where the caller stands, as every other tool reads a path; the default is the repository's own out/. */
function outDir() {
  const at = process.argv.indexOf('--out')
  const named = at === -1 ? null : process.argv[at + 1]
  if (at !== -1 && !named) throw new Error('--out needs a directory')
  return named ? path.resolve(named) : path.join(root, 'out/site')
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

/**
 * The release the buttons name, or null with the reason said. Two things turn
 * "none" into a stop: the switch that requires one, and a release asked for by
 * name, which is never quietly swapped for nothing.
 */
async function readRelease(site, offline, required) {
  const tag = env.COOKREW_SITE_RELEASE || undefined
  if (tag !== undefined && !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(tag)) throw new Error(`COOKREW_SITE_RELEASE must be a tag like v0.6.0 (got ${JSON.stringify(tag)})`)
  const none = (why) => {
    if (tag !== undefined) throw new Error(`${tag} was asked for by name and ${why}`)
    if (required) throw new Error(`a release is required and ${why}`)
    process.stdout.write(`site: no release is named (${why}); the button points at the list of releases\n`)
    return null
  }
  if (offline) return none('the build is offline')
  let release
  try {
    // Believed here as the pages will believe it: an installable whose address is not this project's is not one.
    release = site.believedRelease(site.parseRelease(await github(tag ? site.RELEASES_API.replace(/latest$/, `tags/${tag}`) : site.RELEASES_API)))
  } catch (error) {
    return none(`GitHub could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!release) return none('GitHub answered something that is not a release')
  if (!site.pickAsset(release, 'mac')) return none(`${release.tag} has no Mac build yet`)
  return release
}

async function readCommits(site, offline) {
  if (offline) return null
  try {
    return site.parseCommits(await github(site.COMMITS_API))
  } catch (error) {
    process.stdout.write(`site: no commit list (${error instanceof Error ? error.message : String(error)})\n`)
    return null
  }
}

/** The pictures and films the pages name, by file name. */
function mediaNamed(files, frames) {
  const named = new Set()
  for (const body of files.values()) {
    if (typeof body !== 'string') continue
    for (let at = body.indexOf(frames); at !== -1; at = body.indexOf(frames, at + 1)) {
      const name = /^[A-Za-z0-9._-]+/.exec(body.slice(at + frames.length))
      if (name) named.add(name[0])
    }
  }
  return [...named]
}

/**
 * Every one of them has to be a file AT THE COMMIT the pages read them from.
 * The working copy is not asked: a picture recorded and not committed is on
 * this disk and on nobody's screen.
 */
function missingAt(ref, names) {
  const dir = 'registry/assets/site'
  let listed
  try {
    listed = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, '--', dir], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    throw new Error(`the commit the pictures are read at is not in this repository: ${ref}`)
  }
  const held = new Set(listed.split('\n').map((line) => line.slice(dir.length + 1)))
  return names.filter((name) => !held.has(name))
}

/** A directory this build may replace: none yet, an empty one, or one whose _headers a build signed. */
function ours(out, mark) {
  if (!existsSync(out)) return true
  if (readdirSync(out).length === 0) return true
  const headers = path.join(out, '_headers')
  return existsSync(headers) && readFileSync(headers, 'utf8').startsWith(mark)
}

function write(dir, files) {
  let bytes = 0
  for (const [name, body] of files) {
    const target = path.resolve(dir, name)
    if (!target.startsWith(dir + path.sep)) throw new Error(`a file of the site would be written outside it: ${name}`)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, body)
    bytes += typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength
  }
  return bytes
}

/**
 * WRITTEN BESIDE, THEN SWAPPED IN. The site is made whole in a directory next
 * to the target and takes its place in one rename, so a build that fails
 * halfway leaves the last good site where it was and nothing half-made that a
 * later build would refuse to touch.
 */
function publish(out, files, mark) {
  if (!ours(out, mark)) throw new Error(`${out} holds files this build did not make; it is left alone`)
  const beside = `${out}.building-${process.pid}`
  rmSync(beside, { recursive: true, force: true })
  try {
    mkdirSync(beside, { recursive: true })
    const bytes = write(beside, files)
    rmSync(out, { recursive: true, force: true })
    renameSync(beside, out)
    return bytes
  } catch (error) {
    rmSync(beside, { recursive: true, force: true })
    throw error
  }
}

async function main() {
  const out = outDir()
  const offline = flag('COOKREW_SITE_OFFLINE')
  const required = flag('COOKREW_SITE_REQUIRE_RELEASE')
  const ref = siteRef()
  const site = await generator(ref)
  const [release, commits] = await Promise.all([readRelease(site, offline, required), readCommits(site, offline)])
  const files = site.buildStaticSite({
    release,
    commits,
    console: env.COOKREW_CONSOLE_ORIGIN || 'https://console.cookrew.dev',
    auth: env.COOKREW_AUTH_ORIGIN || 'https://auth.cookrew.dev',
    fonts: site.siteFonts()
  })
  const missing = missingAt(ref, mediaNamed(files, site.SITE_FRAMES))
  if (missing.length > 0) throw new Error(`the pages name pictures the commit ${ref.slice(0, 12)} does not hold in registry/assets/site: ${missing.join(', ')}`)
  const bytes = publish(out, files, site.STATIC_SITE_MARK)
  process.stdout.write(`site: ${files.size} files, ${Math.round(bytes / 1024)} KB in ${path.relative(process.cwd(), out) || '.'}; ${release ? `names ${release.tag}` : 'names no release'}; pictures at ${ref.slice(0, 12)}\n`)
}

main().catch((error) => {
  process.stderr.write(`site build failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
