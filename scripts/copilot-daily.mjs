#!/usr/bin/env node
/**
 * The daily Copilot lane: one task a day, paid from the month's Copilot quota.
 *
 *   npm run daily:run                       # a real lane
 *   npm run daily:run -- --dry-run          # gates and the task choice, no spend
 *   npm run daily:run -- --task "fix ..."   # the owner's brief instead of the queue
 *   npm run daily:run -- --model gpt-5.6-sol
 *   npm run daily:status
 *
 * The queue: a red dev first, then the owner's issues labelled `copilot`, each
 * tried once, then the standing chores in rotation. See copilot-daily-ops.mjs for
 * how a lane is held apart. This runner merges into dev only when nothing got
 * worse, and never pushes. History is in ~/.cookrew/copilot-daily/history.jsonl.
 */
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import {
  acceptLane, dailyBudget, hardCap, mergeBlockers, ownerTask, pickTask, summaryOf, trustedIssues, weakenedTests
} from './copilot-daily-lib.mjs'
import {
  GITHUB_REPO, REPO, STATE, accountToken, collectLane, fetchQuota, gh, git, notify, openLanes, removeTree, run,
  runGates, runSession, safeMerge, say, sweepStale, syncWithDev, takeLock, waitForRoom
} from './copilot-daily-ops.mjs'

const MIN_CREDITS = 15
const DAY_MS = 86_400_000
const LOCK = path.join(STATE, 'run.lock')
const HISTORY = path.join(STATE, 'history.jsonl')

function option(name) {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}

function history() {
  if (!existsSync(HISTORY)) return []
  return readFileSync(HISTORY, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function labelledIssues(token) {
  const fields = ['--json', 'number,title,body,author', '--limit', '20']
  const issues = JSON.parse(gh(token, 'issue', 'list', '-R', GITHUB_REPO, '--label', 'copilot', '--state', 'open', ...fields))
  return trustedIssues(issues, history().map((entry) => entry.task))
}

function chooseTask({ failures, token }) {
  const brief = option('--task')
  if (brief) return ownerTask(brief)
  return pickTask({ failures, issues: labelledIssues(token), day: Math.floor(Date.now() / DAY_MS) })
}

function dirtyFiles() {
  const { stdout } = run('git', ['status', '--porcelain', '--no-renames'], { cwd: REPO })
  return stdout.split('\n').filter(Boolean).map((line) => line.slice(3))
}

function mergeIntoDev(branch, subject) {
  const blockers = mergeBlockers({
    changed: git(REPO, 'diff', '--name-only', '--no-renames', `dev...${branch}`).split('\n').filter(Boolean),
    dirty: dirtyFiles(),
    branch: git(REPO, 'rev-parse', '--abbrev-ref', 'HEAD')
  })
  if (blockers.length > 0) return { merged: false, reason: blockers.join('; ') }
  return safeMerge({ repo: REPO, branch, message: `${subject}, into dev (${branch})` })
}

/** A cut-off session may leave half a change that still passes, so it never lands by itself. */
function landLane({ tree, branch, task, before, session, subject }) {
  if (session.stopped || session.code !== 0) {
    return { merged: false, subject, reason: `kept on ${branch}: session ended early (${session.stopped ?? `exit ${session.code}`})` }
  }
  const weakened = weakenedTests(git(tree, 'diff', '--no-renames', 'HEAD~1', 'HEAD', '--', 'tests'))
  if (weakened) return { merged: false, subject, reason: `kept on ${branch}: ${weakened}` }
  if (!syncWithDev(tree)) return { merged: false, subject, reason: `kept on ${branch}: conflicts with dev` }
  say('re-running the gates')
  const after = runGates(tree)
  const verdict = acceptLane({ before, after, mustClear: task.id === 'green' })
  if (!verdict.ok) return { merged: false, subject, reason: `kept on ${branch}: ${verdict.reason}`, after: after.failures }
  return { ...mergeIntoDev(branch, subject), subject, after: after.failures }
}

function spentSince(token, quota) {
  try {
    return quota.remaining - fetchQuota(token).remaining
  } catch (error) {
    say(`could not read the spend: ${error.message}`)
    return null
  }
}

async function workLane({ lanes, branch, stamp, task, token, quota, budget, before }) {
  const cap = hardCap(budget, quota.remaining)
  say(`task ${task.id}: ${task.title} (share ${budget}, cap ${cap})`)
  const session = await runSession({
    cwd: lanes.lane, prompt: task.brief, model: option('--model'), token, cap, startRemaining: quota.remaining,
    logFile: path.join(STATE, 'logs', `${stamp}.jsonl`)
  })
  const subject = summaryOf(session.message, task.id)
  const body = `Daily Copilot lane, task: ${task.title}.`
  const changed = collectLane({ repo: REPO, lane: lanes.lane, tree: lanes.tree, subject, body })
  const spent = spentSince(token, quota)
  if (!changed) return { spent, merged: false, reason: 'no changes' }
  return { spent, ...landLane({ tree: lanes.tree, branch, task, before, session, subject }) }
}

function record(entry) {
  appendFileSync(HISTORY, `${JSON.stringify(entry)}\n`)
  const line = `${entry.task}: ${entry.reason ?? entry.skipped} (${entry.spent ?? 0} credits)`
  say(line)
  notify(line)
}

function closeLanes({ lane, tree }, branch, keepLane) {
  // A commit that did not reach dev outlives the lane, whatever stopped it.
  removeTree(tree, branch, { keepBranch: git(REPO, 'rev-list', '--count', `dev..${branch}`) !== '0' })
  if (keepLane) say(`the lane's uncollected work is still in ${lane}`)
  else rmSync(lane, { recursive: true, force: true })
}

async function daily() {
  sweepStale()
  if (!(await waitForRoom())) return record({ stamp: new Date().toISOString(), task: 'none', skipped: 'the machine stayed busy' })
  const token = accountToken()
  const quota = fetchQuota(token)
  const budget = dailyBudget({ remaining: quota.remaining, resetDate: quota.resetDate, now: new Date() })
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  if (budget < MIN_CREDITS) return record({ stamp, task: 'none', skipped: `share is ${budget} credits` })
  const branch = `daily/${stamp}`
  const lanes = openLanes(`daily-${stamp}`, branch)
  let keepLane = false
  try {
    say(`quota ${quota.remaining}/${quota.entitlement}, resets ${quota.resetDate}; gating ${lanes.tree}`)
    const before = runGates(lanes.tree)
    const task = chooseTask({ failures: before.failures, token })
    if (process.argv.includes('--dry-run')) {
      return say(`dry run: ${before.active} tests, ${before.failures.length} failures, would run ${task.id}\n${before.failures.join('\n')}`)
    }
    keepLane = true
    const outcome = await workLane({ lanes, branch, stamp, task, token, quota, budget, before })
    keepLane = false
    return record({ stamp, branch, task: task.id, before: before.failures, remaining: quota.remaining, ...outcome })
  } finally {
    closeLanes(lanes, branch, keepLane)
  }
}

function status() {
  const token = accountToken()
  const quota = fetchQuota(token)
  const share = dailyBudget({ remaining: quota.remaining, resetDate: quota.resetDate, now: new Date() })
  say(`Copilot ${quota.remaining}/${quota.entitlement} credits, ${share} a day until ${quota.resetDate}`)
  for (const entry of history().slice(-7)) say(`${entry.stamp} ${entry.task}: ${entry.reason ?? entry.skipped} (${entry.spent ?? 0} credits)`)
}

async function main() {
  if (process.argv.includes('--status')) return status()
  if (!takeLock(LOCK)) return say('another lane is running')
  try {
    return await daily()
  } finally {
    rmSync(LOCK, { recursive: true, force: true })
  }
}

main().catch((error) => {
  say(`failed: ${error.message}`)
  notify(`failed: ${error.message}`)
  process.exitCode = 1
})
