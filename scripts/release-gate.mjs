// WHAT MUST HOLD BEFORE A RELEASE GOES OUT (.github/workflows/release.yml).
//
//   node scripts/release-gate.mjs tag <tag>         the tag names package.json's version
//   node scripts/release-gate.mjs branch <tag>      the tag is a merge of dev into main
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

/**
 * Why the tagged commit cannot be packaged; null when it can. A release is built
 * from main only, and only from a commit that merged dev into it (owner,
 * 2026-11-16): a tag on a branch, on a direct push to main, or on a merge of
 * anything but dev ships code that never went through dev.
 */
export function branchProblem({ tag, onMain, parents, mergedFromDev }) {
  if (!onMain) return `${tag} is not on main: a release is built from main only`
  if (parents.length !== 2) return `${tag} is not a merge commit: a release is a merge of dev into main`
  return mergedFromDev ? null : `${tag} merges a branch other than dev into main`
}

function isAncestor(commit, ref) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, ref], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function branchFacts(tag) {
  const [head, ...parents] = execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { encoding: 'utf8' }).trim().split(/\s+/)
  // ON main's own line, not merely reachable from it: every dev commit is an
  // ancestor of main once merged, and a merge INTO dev would pass as one of main's.
  const mainLine = execFileSync('git', ['rev-list', '--first-parent', 'origin/main'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n')
  return {
    tag,
    onMain: mainLine.includes(head),
    parents,
    mergedFromDev: parents.length === 2 && isAncestor(parents[1], 'origin/dev')
  }
}

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
  if (command === 'branch') {
    const problem = branchProblem(branchFacts(tag))
    if (problem !== null) fail(problem)
    return
  }
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
