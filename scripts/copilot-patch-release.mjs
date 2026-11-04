#!/usr/bin/env node
/**
 * Cut the next patch version from dev.
 *
 *   npm run daily:release -- --dry-run   # gates, build and notes (a small Copilot spend); no push
 *   npm run daily:release                # ... then dev -> main, tag, draft release
 *   npm run daily:release -- --publish   # ... and take the draft public once its installers are up
 *
 * The bar is the one every release so far met: gates green with COOKREW_* unset
 * here, then mac + ubuntu CI on the PR, which also runs the suites the sandboxed
 * gate leaves out. Each step reads where the release stands on the remote, so
 * running this again after a stop resumes at the step that stopped.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { laneEnv, missingAssets, releaseBar, releaseStage } from './copilot-daily-lib.mjs'
import {
  GITHUB_REPO, REPO, STATE, accountToken, createTree, fetchQuota, gh, git, notify, reclaimTree, removeTree, run,
  runGates, runSession, safeMerge, say, syncWithDev
} from './copilot-daily-ops.mjs'

const NOTES_CAP = 25
const POLL_MS = 60_000
const WAIT_LIMIT_MS = 60 * 60_000
const PR_FOOTER = '\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n'

const fileVersion = (ref) => JSON.parse(git(REPO, 'show', `${ref}:package.json`)).version

function readRemote(token) {
  git(REPO, 'fetch', '-q', '--tags', 'origin', 'main')
  const lines = git(REPO, 'ls-remote', '--tags', 'origin', 'v*').split('\n')
  const tags = lines.map((line) => line.split('refs/tags/')[1]).filter((tag) => tag && !tag.endsWith('^{}'))
  const releases = JSON.parse(gh(token, 'release', 'list', '-R', GITHUB_REPO, '--limit', '20', '--json', 'tagName,isDraft'))
  const published = releases.filter((release) => !release.isDraft).map((release) => release.tagName)
  return { tags, published, mainVersion: JSON.parse(git(REPO, 'show', 'FETCH_HEAD:package.json')).version }
}

/** Tags sit on main's merge commits, off dev's history, so describe would find an old one. */
function previousTag(published) {
  const sorted = git(REPO, 'tag', '--list', 'v[0-9]*.[0-9]*.[0-9]*', '--sort=-v:refname').split('\n')
  return sorted.find((tag) => published.includes(tag))
}

function verify(tree) {
  say('running the gates')
  const { failures, active } = runGates(tree, { build: true })
  if (failures.length > 0) throw new Error(`dev is red:\n${failures.join('\n')}`)
  say(`${active} tests green, build clean`)
}

const notesFile = (version) => path.join(STATE, 'notes', `release-${version}.md`)

/** Keyed on the head commit: notes written before a CI fix would miss what came after. */
async function writeNotes({ tree, version, previous, token }) {
  const file = notesFile(version)
  const head = git(tree, 'rev-parse', 'HEAD')
  if (existsSync(file) && existsSync(`${file}.head`) && readFileSync(`${file}.head`, 'utf8') === head) return file
  mkdirSync(path.dirname(file), { recursive: true })
  const subjects = git(tree, 'log', '--no-merges', '--format=%s', `${previous}..HEAD`)
  const prompt = `Write the GitHub release notes for Cookrew ${version} from these commit subjects. Group by what a user notices (New, Better, Fixed), plain English, at most 12 bullets, merge related commits, leave out internal test and tooling work. Output the markdown only, no preamble, and touch no files.\n\n${subjects}`
  const cwd = mkdtempSync(path.join(tmpdir(), 'cookrew-notes-'))
  const { remaining } = fetchQuota(token)
  const session = await runSession({
    cwd, prompt, token, cap: Math.min(NOTES_CAP, remaining), startRemaining: remaining,
    logFile: path.join(STATE, 'logs', `release-${version}.jsonl`)
  })
  rmSync(cwd, { recursive: true, force: true })
  if (session.stopped || session.code !== 0 || !session.message) throw new Error('the notes session did not finish')
  writeFileSync(file, `${session.message.trim()}\n`)
  writeFileSync(`${file}.head`, head)
  return file
}

function bumpVersion(tree, version, branch) {
  const env = laneEnv(process.env)
  const bumped = run('npm', ['version', version, '--no-git-tag-version', '--ignore-scripts'], { cwd: tree, env })
  if (!bumped.ok) throw new Error(`npm version failed: ${bumped.stderr.trim()}`)
  git(tree, 'add', 'package.json', 'package-lock.json')
  git(tree, 'commit', '-q', '-m', `chore: ${version}`)
  if (!syncWithDev(tree)) throw new Error(`${branch} conflicts with dev`)
  const onDev = git(REPO, 'rev-parse', '--abbrev-ref', 'HEAD') === 'dev'
  const dirty = run('git', ['status', '--porcelain', '--', 'package.json', 'package-lock.json'], { cwd: REPO }).stdout
  if (!onDev || dirty) throw new Error('the main tree is off dev or has package files uncommitted')
  const result = safeMerge({ repo: REPO, branch, message: `chore: merge ${version}, into dev (${branch})` })
  if (!result.merged) throw new Error(result.reason)
}

function push(token, ref) {
  const helper = '!f() { echo username=favon24; echo "password=$GH_TOKEN"; }; f'
  const env = { ...laneEnv(process.env), GH_TOKEN: token }
  const args = ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, 'push', `https://github.com/${GITHUB_REPO}.git`, ref]
  const pushed = run('git', args, { cwd: REPO, env })
  if (!pushed.ok) throw new Error(`push ${ref} failed: ${pushed.stderr.trim()}`)
}

function openPullRequest(token, version, notes) {
  const found = JSON.parse(gh(token, 'pr', 'list', '-R', GITHUB_REPO, '--head', 'dev', '--base', 'main', '--json', 'number'))
  if (found[0]) return found[0].number
  const bodyFile = `${notes}.pr`
  writeFileSync(bodyFile, `${readFileSync(notes, 'utf8').trim()}${PR_FOOTER}`)
  const url = gh(token, 'pr', 'create', '-R', GITHUB_REPO, '--base', 'main', '--head', 'dev', '--title', `Release ${version}`, '--body-file', bodyFile)
  return Number(url.trim().split('/').pop())
}

async function until(limitLabel, check) {
  const deadline = Date.now() + WAIT_LIMIT_MS
  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    if (check()) return
  }
  throw new Error(`${limitLabel} after an hour`)
}

function barPassed(token, number) {
  const env = { ...laneEnv(process.env), GH_TOKEN: token }
  // gh pr checks exits non-zero while anything is red or pending, so its status says nothing here.
  const { stdout } = run('gh', ['pr', 'checks', String(number), '-R', GITHUB_REPO, '--json', 'name,bucket'], { env })
  const verdict = stdout.trim() ? releaseBar(JSON.parse(stdout)) : 'pending'
  if (verdict === 'failed') throw new Error(`CI failed on PR #${number}; fix it on dev and run this again`)
  return verdict === 'passed'
}

async function landOnMain({ token, version, notes }) {
  push(token, 'dev')
  const head = git(REPO, 'rev-parse', 'dev')
  const number = openPullRequest(token, version, notes)
  say(`PR #${number}: waiting for mac + ubuntu`)
  await until(`CI still running on PR #${number}`, () => barPassed(token, number))
  gh(token, 'pr', 'merge', String(number), '-R', GITHUB_REPO, '--merge', '--subject', `Release ${version}`, '--match-head-commit', head)
}

function tagMain(token, tag, version) {
  git(REPO, 'fetch', '-q', 'origin', 'main')
  if (!run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { cwd: REPO }).ok) {
    git(REPO, 'tag', '-a', tag, '-m', `Cookrew ${version}`, 'FETCH_HEAD')
  }
  push(token, tag)
}

function buildFinished(token, tag) {
  const fields = ['--workflow', 'release.yml', '--branch', tag, '--json', 'status,conclusion', '--limit', '1']
  const [latest] = JSON.parse(gh(token, 'run', 'list', '-R', GITHUB_REPO, ...fields))
  if (latest?.status !== 'completed') return false
  if (latest.conclusion !== 'success') throw new Error(`the ${tag} build ended ${latest.conclusion}`)
  return true
}

/** Publishing early strands the installers: electron-builder only uploads to a draft. */
async function finishDraft({ token, tag, version, publish }) {
  say(`waiting for the ${tag} build`)
  await until(`the ${tag} build is unfinished`, () => buildFinished(token, tag))
  const { assets } = JSON.parse(gh(token, 'release', 'view', tag, '-R', GITHUB_REPO, '--json', 'assets'))
  const missing = missingAssets(assets.map((asset) => asset.name))
  if (missing.length > 0) throw new Error(`${tag} is missing ${missing.join(', ')}`)
  const notes = existsSync(notesFile(version)) ? ['--notes-file', notesFile(version)] : []
  gh(token, 'release', 'edit', tag, '-R', GITHUB_REPO, ...notes, ...(publish ? ['--draft=false', '--latest'] : []))
}

/** Gates, build, notes, bump: the part that needs a tree. Returns the notes file, or null on a dry run. */
async function prepare({ version, stage, previous, token }) {
  const branch = `release/${version}`
  reclaimTree(`release-${version}`, branch)
  const tree = createTree(`release-${version}`, branch, 'dev')
  try {
    verify(tree)
    const notes = await writeNotes({ tree, version, previous, token })
    if (process.argv.includes('--dry-run')) {
      say(`dry run ends here; ${previous} to ${version}, notes in ${notes}`)
      return null
    }
    if (stage === 'bump') bumpVersion(tree, version, branch)
    return notes
  } finally {
    removeTree(tree, branch, { keepBranch: false })
  }
}

async function main() {
  const token = accountToken()
  const remote = readRemote(token)
  const { version, stage } = releaseStage({ ...remote, version: fileVersion('dev') })
  const tag = `v${version}`
  const publish = process.argv.includes('--publish')
  say(`release ${version}: at ${stage}`)
  if (stage === 'bump' || stage === 'pr') {
    const notes = await prepare({ version, stage, previous: previousTag(remote.published), token })
    if (!notes) return undefined
    await landOnMain({ token, version, notes })
  } else if (process.argv.includes('--dry-run')) {
    return say(`dry run: ${version} is past the gates, at ${stage}`)
  }
  if (stage !== 'draft') tagMain(token, tag, version)
  await finishDraft({ token, tag, version, publish })
  const url = `https://github.com/${GITHUB_REPO}/releases/tag/${tag}`
  say(`${publish ? 'published' : 'draft ready'}: ${url}`)
  return notify(`${version} ${publish ? 'published' : 'draft ready'}`)
}

main().catch((error) => {
  say(`failed: ${error.message}`)
  notify(`release failed: ${error.message}`)
  process.exitCode = 1
})
