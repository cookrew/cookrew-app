// WHAT MUST HOLD BEFORE A RELEASE GOES OUT (.github/workflows/release.yml).
//
//   node scripts/release-gate.mjs tag <tag>         the tag names package.json's version
//   node scripts/release-gate.mjs assets <tag>      the draft holds everything an app needs
//   node scripts/release-gate.mjs prerelease <tag>  exits 0 for a tag with a suffix
//
// Publishing puts a build in front of every running app, so a wrong version or a
// missing feed file has to stop here rather than be found by users.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/

/** Why this tag cannot release this package; null when it can. */
export function tagProblem(tag, version) {
  const named = TAG.exec(tag)?.[1]
  if (named === undefined) return `${tag} is not a version tag like v1.2.3`
  return named === version ? null : `${tag} names ${named}, but package.json says ${version}`
}

export const isPrerelease = (tag) => tag.includes('-')

/** What the updater reads, then what people download. */
const required = (version) => [
  'latest-mac.yml',
  'latest.yml',
  `Cookrew-${version}-arm64-mac.zip`,
  `Cookrew-${version}-arm64.dmg`,
  `Cookrew-${version}-windows-preview-x64.exe`
]

export const missingAssets = (names, version) => required(version).filter((name) => !names.includes(name))

function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

function main([command, tag = '']) {
  if (command === 'prerelease') process.exit(isPrerelease(tag) ? 0 : 1)
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const problem = tagProblem(tag, version)
  if (problem !== null) fail(problem)
  if (command === 'tag') return
  if (command !== 'assets') fail(`unknown command ${command}`)
  const raw = execFileSync('gh', ['release', 'view', tag, '--json', 'assets'], { encoding: 'utf8' })
  const missing = missingAssets(JSON.parse(raw).assets.map((asset) => asset.name), version)
  if (missing.length > 0) fail(`${tag} is missing ${missing.join(', ')}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
