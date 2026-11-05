/**
 * The side effects shared by the daily Copilot lane and the patch release.
 * Decisions live in copilot-daily-lib.mjs, where they can be tested.
 *
 * A lane is two directories. The LANE is a standalone clone where Copilot works
 * inside the OS sandbox; it shares no .git with the repo, and the runner never
 * runs git through its .git, so nothing planted there executes. The TREE is a
 * linked worktree only the runner touches: it takes the lane's files, commits
 * them and gates them with its own dependencies, under a sandbox of its own,
 * because a lane's tests are code it wrote.
 */
import { execFile, spawn, spawnSync } from 'node:child_process'
import {
  createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync
} from 'node:fs'
import { availableParallelism, homedir, loadavg } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  SANDBOX_EXCLUDED_SUITES, collectBlockers, copilotArgs, gateProfile, laneEnv, parseListening, parseQuota, tooBusy, typeFailures,
  vitestOutcome
} from './copilot-daily-lib.mjs'

export const REPO = process.env.COOKREW_DAILY_REPO ?? path.join(homedir(), 'workspace', 'cookrew-dev')
export const STATE = path.join(homedir(), '.cookrew', 'copilot-daily')
export const GITHUB_REPO = 'cookrew/cookrew-app'

// `.noindex`: every run clones a lane and copies all of node_modules into it, and
// Spotlight read each file (2026-11-05: 44,277 .ts files indexed under the old
// `cookrew-wt`, none under `.claude/worktrees`, which is hidden).
const WORKTREES = path.join(homedir(), 'workspace', 'cookrew-wt.noindex')
/** The account holding the Copilot plan and push rights; the active gh login has neither. */
const ACCOUNT = 'favon24'
/** Its own config dir: the owner's global hooks fail closed and deny every tool call here. */
const COPILOT_HOME = path.join(STATE, 'home')
const LANE_SCRATCH = '.lane-tmp'
const CLONE_DEPTH = '400'
const QUOTA_POLL_MS = 60_000
const QUOTA_MISSES_ALLOWED = 3
const GH_TIMEOUT_MS = 60_000
const SESSION_LIMIT_MS = 45 * 60_000
const KILL_GRACE_MS = 15_000
const GATE_STEP_LIMIT_MS = 30 * 60_000
const BUSY_POLL_MS = 5 * 60_000
const BUSY_LIMIT_MS = 3 * 3_600_000
const STALE_LANE_MS = 7 * 86_400_000
const STALE_LOCK_MS = 6 * 3_600_000
const MAX_BUFFER = 256 * 1024 * 1024
const NOISY_EVENT = /^(assistant\.(tool_call|message)_delta|session\.background_tasks_changed|tool\.execution_partial_result)$/

export function say(line) {
  process.stdout.write(`[${new Date().toISOString()}] ${line}\n`)
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER, ...options })
  return {
    ok: result.status === 0,
    timedOut: result.error?.code === 'ETIMEDOUT',
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

export function git(cwd, ...args) {
  const result = run('git', args, { cwd, env: laneEnv(process.env) })
  if (!result.ok) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

export function accountToken() {
  const result = run('gh', ['auth', 'token', '-u', ACCOUNT], { env: laneEnv(process.env), timeout: GH_TIMEOUT_MS })
  if (!result.ok) throw new Error(`no gh login for ${ACCOUNT}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

/** The proxy on this machine drops a GitHub call now and then, so a call gets three tries. */
export function gh(token, ...args) {
  const env = { ...laneEnv(process.env), GH_TOKEN: token }
  const attempt = () => run('gh', args, { env, timeout: GH_TIMEOUT_MS })
  const result = [attempt, attempt, attempt].reduce((last, next) => (last?.ok ? last : next()), null)
  if (!result.ok) throw new Error(`gh ${args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout
}

export function fetchQuota(token) {
  return parseQuota(JSON.parse(gh(token, 'api', '/copilot_internal/user')))
}

function cloneDependencies(target) {
  const copied = run('cp', ['-cR', path.join(REPO, 'node_modules'), path.join(target, 'node_modules')])
  if (!copied.ok) throw new Error(`could not clone node_modules: ${copied.stderr.trim()}`)
}

/** A linked worktree the runner owns, with its own APFS clone of the dependencies. */
export function createTree(name, branch, base) {
  mkdirSync(WORKTREES, { recursive: true })
  const tree = path.join(WORKTREES, name)
  git(REPO, 'worktree', 'add', '-q', '-b', branch, tree, base)
  try {
    cloneDependencies(tree)
    return tree
  } catch (error) {
    removeTree(tree, branch, { keepBranch: false })
    throw error
  }
}

export function removeTree(tree, branch, { keepBranch }) {
  git(REPO, 'worktree', 'remove', '--force', tree)
  if (!keepBranch) git(REPO, 'branch', '-D', branch)
}

/** A run killed outright leaves its tree behind; the next run of that name clears it. */
export function reclaimTree(name, branch) {
  const tree = path.join(WORKTREES, name)
  if (existsSync(tree)) git(REPO, 'worktree', 'remove', '--force', tree)
  if (!run('git', ['rev-parse', '-q', '--verify', `refs/heads/${branch}`], { cwd: REPO }).ok) return
  if (git(REPO, 'rev-list', '--count', `dev..${branch}`) !== '0') throw new Error(`${branch} holds commits dev lacks`)
  git(REPO, 'branch', '-D', branch)
}

function createLane(name) {
  mkdirSync(WORKTREES, { recursive: true })
  const lane = path.join(WORKTREES, name)
  git(WORKTREES, 'clone', '-q', '--no-hardlinks', '--depth', CLONE_DEPTH, '--branch', 'dev', `file://${REPO}`, lane)
  git(lane, 'remote', 'remove', 'origin')
  mkdirSync(path.join(lane, LANE_SCRATCH))
  cloneDependencies(lane)
  return lane
}

/** The tree starts from the commit the lane cloned, or collecting would undo what dev gained. */
export function openLanes(name, branch) {
  const lane = createLane(`${name}-lane`)
  try {
    return { lane, tree: createTree(name, branch, git(lane, 'rev-parse', 'HEAD')) }
  } catch (error) {
    rmSync(lane, { recursive: true, force: true })
    throw error
  }
}

function untrackedInMain(repo, file) {
  return existsSync(path.join(repo, file)) && git(repo, 'ls-tree', 'dev', '--', file) === ''
}

/**
 * Commits the lane's files on the tree's branch, through the tree's git dir, so
 * neither hooks nor config from the lane's own .git come into it.
 */
export function collectLane({ repo, lane, tree, subject, body }) {
  const env = { ...laneEnv(process.env), GIT_DIR: git(tree, 'rev-parse', '--absolute-git-dir'), GIT_WORK_TREE: lane }
  const added = run('git', ['add', '-A', '--', '.', `:!${LANE_SCRATCH}`], { cwd: lane, env })
  if (!added.ok) throw new Error(`could not collect the lane: ${added.stderr.trim()}`)
  if (run('git', ['diff', '--cached', '--quiet'], { cwd: tree }).ok) return false
  const raw = git(tree, 'diff', '--cached', '--raw', '--no-renames', '--no-abbrev')
  const blockers = collectBlockers({ raw, collides: (file) => untrackedInMain(repo, file) })
  if (blockers.length > 0) throw new Error(`refused the lane's files: ${blockers.join('; ')}`)
  git(tree, 'commit', '-q', '-m', subject, '-m', body, '-m', 'Co-Authored-By: GitHub Copilot <noreply@github.com>')
  git(tree, 'reset', '-q', '--hard', 'HEAD')
  return true
}

/** Conflicts are settled in the tree, never in the main tree, which the running app serves. */
export function syncWithDev(tree) {
  const merged = run('git', ['merge', '--no-edit', 'dev'], { cwd: tree })
  if (merged.ok) return true
  run('git', ['merge', '--abort'], { cwd: tree })
  return false
}

/**
 * merge-tree first, so a conflict never reaches the main tree. dev can still move
 * in the gap: a merge of ours that went wrong is aborted, and anything else in
 * progress there is another lane's and stays.
 */
export function safeMerge({ repo, branch, message }) {
  if (!run('git', ['merge-tree', '--write-tree', 'dev', branch], { cwd: repo }).ok) {
    return { merged: false, reason: 'conflicts with dev' }
  }
  const tip = git(repo, 'rev-parse', branch)
  const merged = run('git', ['merge', '--no-ff', '-q', '-m', message, branch], { cwd: repo })
  if (merged.ok) return { merged: true, reason: 'merged' }
  const inProgress = run('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: repo }).stdout.trim()
  if (inProgress === tip) run('git', ['merge', '--abort'], { cwd: repo })
  return { merged: false, reason: `merge refused: ${(merged.stderr || merged.stdout).trim().slice(0, 200)}` }
}

/**
 * Every port something on this Mac listens on now: the proxy, the app, CDP,
 * Magpie. netstat, because lsof without root leaves out root's listeners, and
 * the system proxy is one.
 */
function listeningPorts() {
  return parseListening(run('netstat', ['-an', '-p', 'tcp']).stdout)
}

function gateScratch(tree) {
  const scratch = realpathSync(mkdtempSync('/private/tmp/cookrew-daily-gate-'))
  const home = path.join(scratch, 'home')
  const tmp = path.join(scratch, 'tmp')
  mkdirSync(home)
  mkdirSync(tmp)
  const profile = gateProfile({
    writable: [realpathSync(tree), scratch],
    readable: [realpathSync(tree), scratch, realpathSync(path.join(REPO, '.git'))],
    home: homedir(),
    listening: listeningPorts()
  })
  return { scratch, profile, env: { ...laneEnv(process.env), HOME: home, TMPDIR: `${tmp}/` } }
}

function vitestRun({ tree, sandboxed, scratch, files }) {
  const report = path.join(scratch, `vitest-${Date.now()}.json`)
  const excludes = SANDBOX_EXCLUDED_SUITES.flatMap((suite) => ['--exclude', suite])
  sandboxed('npx', ['vitest', 'run', ...files, ...excludes, '--reporter=json', `--outputFile=${report}`])
  if (!existsSync(report)) return { failures: ['vitest: wrote no report'], active: 0 }
  return vitestOutcome(JSON.parse(readFileSync(report, 'utf8')), realpathSync(tree))
}

function retryFailed({ tree, sandboxed, scratch, failures }) {
  const files = [...new Set(failures.map((failure) => failure.split(' > ')[0]).filter((file) => file.startsWith('tests/')))]
  return files.length > 0 ? vitestRun({ tree, sandboxed, scratch, files }).failures : failures
}

/**
 * What is red at this tree, and how many tests ran. A failed test gets two runs
 * alone: timing suites fail at the load a busy fleet reaches, and that is not
 * the code being wrong. One measured at load 91 passed 6/6 straight after.
 */
export function runGates(tree, { build = false } = {}) {
  const { scratch, profile, env } = gateScratch(tree)
  const sandboxed = (command, args) => {
    const result = run('sandbox-exec', ['-p', profile, command, ...args], { cwd: tree, env, timeout: GATE_STEP_LIMIT_MS })
    // A step that ran out of time says the machine is busy, not that the code is red.
    if (result.timedOut) throw new Error(`gate step ran out of time: ${command} ${args[0]}`)
    return result
  }
  try {
    const types = ['tsconfig.web.json', 'tsconfig.node.json'].flatMap((config) => {
      const result = sandboxed('npx', ['tsc', '--noEmit', '-p', config])
      return typeFailures({ ok: result.ok, output: `${result.stdout}${result.stderr}`, config })
    })
    const first = vitestRun({ tree, sandboxed, scratch, files: [] })
    const again = [1, 2].reduce((left) => retryFailed({ tree, sandboxed, scratch, failures: left }), first.failures)
    const built = !build || sandboxed('npx', ['electron-vite', 'build']).ok
    return { failures: [...types, ...again, ...(built ? [] : ['electron-vite build failed'])], active: first.active }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
  } catch {
    // The group has already gone, which is what was asked for.
  }
}

/**
 * `copilot` is an npm loader running the native binary with spawnSync, so a kill
 * of the child alone leaves the session working. It takes the whole group.
 */
export function stopGroup(child, graceMs = KILL_GRACE_MS) {
  signalGroup(child.pid, 'SIGTERM')
  setTimeout(() => signalGroup(child.pid, 'SIGKILL'), graceMs).unref()
}

/** Asynchronous and bounded, so a hung gh can stall neither this poll nor the session limit. */
function watchQuota({ token, floor, cap, stop }) {
  const env = { ...laneEnv(process.env), GH_TOKEN: token }
  let misses = 0
  const read = (error, stdout) => {
    try {
      if (error) throw error
      const spent = floor - parseQuota(JSON.parse(stdout)).remaining
      misses = 0
      if (spent >= cap) stop(`spent ${spent} of a ${cap} cap`)
    } catch (failure) {
      misses += 1
      say(`quota poll failed (${misses}): ${failure.message}`)
      if (misses >= QUOTA_MISSES_ALLOWED) stop('the quota cannot be read, so the cap cannot hold')
    }
  }
  return setInterval(() => execFile('gh', ['api', '/copilot_internal/user'], { env, timeout: 30_000 }, read), QUOTA_POLL_MS)
}

function parseEvent(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function readEvents(stream, log, onEvent) {
  let rest = ''
  stream.on('data', (chunk) => {
    const lines = `${rest}${chunk}`.split('\n')
    rest = lines.pop() ?? ''
    for (const line of lines) {
      const event = parseEvent(line)
      if (event && !NOISY_EVENT.test(event.type)) log.write(`${line}\n`)
      if (event) onEvent(event)
    }
  })
}

/** Runs one sandboxed session. The hard stop is the quota API, the only live count of spend. */
export function runSession({ cwd, prompt, model, token, cap, startRemaining, logFile }) {
  mkdirSync(COPILOT_HOME, { recursive: true })
  mkdirSync(path.dirname(logFile), { recursive: true })
  const tmp = path.join(cwd, LANE_SCRATCH)
  mkdirSync(tmp, { recursive: true })
  const env = laneEnv(process.env, { copilotHome: COPILOT_HOME, token, tmp })
  const child = spawn('copilot', copilotArgs({ prompt, model }), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(logFile, { flags: 'a' })
  let message = ''
  let stopped = null
  const stop = (reason) => {
    if (stopped) return
    stopped = reason
    say(`stopping the session: ${reason}`)
    stopGroup(child)
  }
  readEvents(child.stdout, log, (event) => {
    if (event.type === 'assistant.message' && event.data?.content) message = event.data.content
  })
  child.stderr.on('data', (chunk) => log.write(chunk))
  const quota = watchQuota({ token, floor: startRemaining, cap, stop })
  const timer = setTimeout(() => stop('45 minute limit'), SESSION_LIMIT_MS)
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      // A job the session left in the background must not edit the lane while it is collected.
      signalGroup(child.pid, 'SIGKILL')
      clearInterval(quota)
      clearTimeout(timer)
      log.end()
      resolve({ message, stopped, code })
    })
  })
}

/** One run at a time. A lock left by a killed run stops holding after six hours. */
export function takeLock(lock) {
  mkdirSync(path.dirname(lock), { recursive: true })
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { recursive: true })
  try {
    mkdirSync(lock)
    return true
  } catch {
    return false
  }
}

/** Timing suites fail and tsc crawls on a saturated machine, so a lane waits for room. */
export async function waitForRoom() {
  const deadline = Date.now() + BUSY_LIMIT_MS
  const load = () => ({ load: loadavg()[0], cores: availableParallelism() })
  while (tooBusy(load())) {
    if (Date.now() > deadline) return false
    say(`waiting for room: load ${loadavg()[0].toFixed(0)}`)
    await sleep(BUSY_POLL_MS)
  }
  return true
}

/** A run killed outright leaves its directories. Kept lanes get a week to be looked at. */
export function sweepStale() {
  const old = Date.now() - STALE_LANE_MS
  mkdirSync(WORKTREES, { recursive: true })
  const stale = readdirSync(WORKTREES).filter((name) => /^daily-\d{4}-/.test(name))
    .map((name) => path.join(WORKTREES, name))
    .filter((dir) => statSync(dir).mtimeMs < old)
  for (const dir of stale) {
    if (!run('git', ['worktree', 'remove', '--force', dir], { cwd: REPO }).ok) rmSync(dir, { recursive: true, force: true })
  }
}

export function notify(line) {
  run('osascript', ['-e', `display notification ${JSON.stringify(line)} with title "Cookrew daily"`])
}
