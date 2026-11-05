/**
 * The decisions of the daily Copilot lane, kept pure so they can be tested.
 * Plain JS because launchd runs a copy of this from ~/.cookrew/bin with no
 * checkout behind it (the same reason as perf-eval-lib.mjs).
 */
import path from 'node:path'

const DAY_MS = 86_400_000

/**
 * Commands a lane has no reason to run. This is a guard against honest mistakes,
 * not a boundary: it matches command strings, so `node -e` walks past it. The
 * boundary is the lane's standalone clone, the OS sandbox and the sandboxed gate.
 */
const DENIED_COMMANDS = [
  'git push', 'git commit', 'git merge', 'git rebase', 'git reset', 'git stash',
  'git checkout', 'git switch', 'git branch', 'git tag', 'git remote', 'git config',
  'git update-ref', 'git worktree',
  'gh', 'gh:*',
  'npm install', 'npm i', 'npm ci', 'npm publish', 'npm run dev', 'npm run dist',
  'electron', 'vite', 'herdr', 'cookrew', 'tmux',
  'kill', 'pkill', 'killall', 'launchctl', 'open', 'osascript', 'curl', 'wget'
]

/**
 * A lane never lands these unattended: dependencies belong to the tree the
 * running app serves, and the rest decide what the gates mean or what runs here
 * with no one watching. The branch stays for the owner to read.
 */
const PROTECTED_FILES = /(^|\/)\.(gitignore|gitattributes|npmrc)$|^(package(-lock)?\.json$|\.github\/|scripts\/|vitest|tsconfig|electron[.-])/

/** The issue queue is open to the public on this repo; only these authors become prompts. */
const OWNERS = new Set(['favon24', 'anvztor'])

/** An allow list: this terminal alone carries several credentials nothing here names. */
const KEPT_ENV = /^(HOME|USER|LOGNAME|LANG|LC_[A-Z]+|TERM|SHELL|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|https?_proxy|all_proxy|no_proxy)$/

/**
 * Suites the gate leaves to CI, because the sandbox itself breaks them: they
 * nest sandbox-exec, boot Chrome (which needs its own sandbox), need real
 * sockets beyond loopback, or write a fixture to a fixed path under /tmp. The
 * release bar still runs them on mac and ubuntu.
 */
export const SANDBOX_EXCLUDED_SUITES = [
  'tests/herdr-host-multiplexer.test.ts',
  'tests/hp-security.test.ts',
  'tests/session-sandbox.test.ts',
  'tests/route-sandbox-deny.test.ts',
  'tests/market-shop-e2e.test.ts',
  'tests/routing-panel-click.test.tsx',
  'tests/rtc-bridge.test.ts',
  'tests/registry-dns-server.test.ts'
]

const LANE_RULES = `
Rules of this lane:
- You are in a throwaway clone of the Cookrew app. Edit files only and read git history freely. The runner takes your working tree and commits it; do not commit.
- Never start the app, Electron, vite or a dev server, and never change package.json or package-lock.json.
- Prove your work with: npx tsc --noEmit -p tsconfig.web.json, npx tsc --noEmit -p tsconfig.node.json, and npx vitest run <files>. The runner re-runs the whole suite afterwards.
- Never delete, skip or weaken a test to make it pass. Before changing a test, read git log for the code it covers: if the behaviour changed on purpose, update the test; if not, fix the code.
- Check git ls-files before creating a test file, so you extend a suite and never overwrite one.
- Keep the diff small and in the surrounding style (single quotes, no semicolons). Do not reformat. English only in code and comments. docs/ is gitignored: leave it.
- Stop once this one task is done. Spare budget is not a reason to widen it.
- End your last message with one line: SUMMARY: <type>: <what changed> (type is fix, test, refactor, perf or chore; one line, English).
`

const CHORES = [
  {
    id: 'review',
    brief: 'Review the commits on this branch from the last two days (git log --since="2 days ago" --no-merges -p) for real defects: a wrong condition, a lost error, a leak, a race. Pick the single most serious one you can prove, write a failing test for it, and fix it. If you can prove nothing, change nothing and say so.'
  },
  {
    id: 'coverage',
    brief: 'Find the source file under src/ with the most commits in the last week that has the weakest test coverage (git log --since="7 days ago" --name-only, then look for its suite in tests/). Add tests for the behaviour it lacks. If a test exposes a bug, fix the bug.'
  },
  {
    id: 'hygiene',
    brief: 'Sweep src/ for one concrete breach of the house rules and fix that one: a console.log left in shipped code, non-English text in a comment, an error swallowed with no handling, or a mutated argument. Pick the instance with the highest user impact and cover the fix with a test.'
  }
]

export function dailyBudget({ remaining, resetDate, now }) {
  const daysLeft = Math.max(1, Math.ceil((Date.parse(`${resetDate}T00:00:00Z`) - now.getTime()) / DAY_MS))
  return Math.floor(Math.max(0, remaining) / daysLeft)
}

export function hardCap(budget, remaining) {
  return Math.min(Math.floor(budget * 1.5), remaining)
}

export function parseQuota(answer) {
  const premium = answer?.quota_snapshots?.premium_interactions
  if (!premium) throw new Error('no premium snapshot in the quota answer')
  if (!Number.isFinite(premium.remaining)) throw new Error('no usable remaining count in the quota answer')
  const resetDate = /^\d{4}-\d{2}-\d{2}/.exec(answer.quota_reset_date ?? '')?.[0]
  if (!resetDate) throw new Error('no usable reset date in the quota answer')
  return { remaining: premium.remaining, entitlement: premium.entitlement, resetDate }
}

export function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`not a plain x.y.z version: ${version}`)
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

/** Where a release stands, read from the remote, so a stop at any step resumes at that step. */
export function releaseStage({ version, tags, published, mainVersion }) {
  const tag = `v${version}`
  if (published.includes(tag)) return { version: nextPatch(version), stage: 'bump' }
  if (tags.includes(tag)) return { version, stage: 'draft' }
  return { version, stage: mainVersion === version ? 'tag' : 'pr' }
}

export function planLine({ version, stage, previous, commits, running }) {
  if (running) return `A release of Cookrew is already running. Pressing again does nothing.`
  const since = `${commits} commits since ${previous}.`
  if (stage === 'draft') return `Cookrew ${version} is tagged. Publish takes the draft public.`
  if (stage === 'tag') return `Cookrew ${version} is on main. Next is the tag.`
  if (stage === 'pr') return `Cookrew ${version} is bumped on dev: ${since}`
  return `Cookrew ${version}: ${since}`
}

/** The AppleScript of the button. It only asks; the launcher does the work, detached. */
export function releaseButtonScript(launcher) {
  return `set launcher to quoted form of "${launcher}"
try
  set plan to do shell script launcher & " plan"
on error failure
  display alert "Release Cookrew" message failure as critical
  return
end try
set answer to button returned of (display dialog plan with title "Release Cookrew" buttons {"Cancel", "Draft", "Publish"} default button "Draft" cancel button "Cancel")
if answer is "Publish" then
  do shell script launcher & " publish"
else
  do shell script launcher & " draft"
end if
display notification "Running. Each step reports here." with title "Release Cookrew"
`
}

export function missingAssets(names) {
  return ['.dmg', '.exe'].filter((suffix) => !names.some((name) => name.endsWith(suffix)))
}

/** Windows is issue #80 and `gates` the stale perf gates: neither is the release bar. */
export function releaseBar(checks) {
  const bar = checks.filter((check) => /^check \((ubuntu|macos)/.test(check.name))
  if (bar.some((check) => check.bucket === 'fail' || check.bucket === 'cancel')) return 'failed'
  return bar.length >= 2 && bar.every((check) => check.bucket === 'pass') ? 'passed' : 'pending'
}

function failuresOfFile(file, root) {
  const name = path.relative(root, file.name)
  const failed = (file.assertionResults ?? []).filter((test) => test.status === 'failed')
  if (failed.length > 0) return failed.map((test) => `${name} > ${test.fullName}`)
  return file.status === 'failed' ? [`${name} > (suite failed to load)`] : []
}

export function parseVitestFailures(report, root) {
  return (report.testResults ?? []).flatMap((file) => failuresOfFile(file, root))
}

/** What a gate run comes to. `active` is what ran, so a removed or skipped test shows. */
export function vitestOutcome(report, root) {
  const failures = parseVitestFailures(report, root)
  const active = (report.numPassedTests ?? 0) + (report.numFailedTests ?? 0)
  const silent = active === 0 || (report.success === false && failures.length === 0)
  return { failures: silent ? [...failures, 'vitest: the run failed with no failing case'] : failures, active }
}

export function typeFailures({ ok, output, config }) {
  const located = parseTscErrors(output)
  return !ok && located.length === 0 ? [`${config}: tsc did not finish`] : located
}

export function parseTscErrors(output) {
  return output
    .split('\n')
    .map((line) => /^(.+?)\(\d+,\d+\): error (TS\d+: .*)$/.exec(line))
    .filter(Boolean)
    .map((match) => `${match[1]} ${match[2]}`)
}

function greenTask(failures) {
  return {
    id: 'green',
    title: 'make dev green',
    brief: `dev is red. Make these gates pass by fixing the real cause of each:\n${failures.map((f) => `- ${f}`).join('\n')}\nIf one passes when you run it alone and only asserts a time limit, it is load, not a bug: leave it and its limit alone and say so.`
  }
}

function issueTask(issue) {
  return {
    id: `issue-${issue.number}`,
    title: `issue #${issue.number}`,
    brief: `Fix GitHub issue #${issue.number}: ${issue.title}\n\n${issue.body}`
  }
}

function withRules(task) {
  return { ...task, brief: `${task.brief}\n${LANE_RULES}` }
}

export function trustedIssues(issues, attempted) {
  return issues.filter((issue) => OWNERS.has(issue.author?.login) && !attempted.includes(`issue-${issue.number}`))
}

export function pickTask({ failures, issues, day }) {
  if (failures.length > 0) return withRules(greenTask(failures))
  const [oldest] = [...issues].sort((a, b) => a.number - b.number)
  if (oldest) return withRules(issueTask(oldest))
  const chore = CHORES[day % CHORES.length]
  return withRules({ ...chore, title: chore.id })
}

export function ownerTask(brief) {
  return withRules({ id: 'owner', title: brief, brief })
}

export function acceptLane({ before, after, mustClear }) {
  const added = after.failures.filter((failure) => !before.failures.includes(failure))
  if (added.length > 0) return { ok: false, reason: `new failures: ${added.join('; ')}` }
  if (after.active < before.active) return { ok: false, reason: `fewer tests ran: ${before.active} to ${after.active}` }
  if (mustClear && after.failures.length >= before.failures.length) {
    return { ok: false, reason: 'cleared none of the failures it was sent to clear' }
  }
  return { ok: true, reason: after.failures.length === 0 ? 'green' : `${after.failures.length} failures left` }
}

function parents(file) {
  const parts = file.split('/')
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

/**
 * `node_modules/` in .gitignore matches a directory only, so a link or file of
 * that name collects, and a clean merge then deletes the ignored directory the
 * running app depends on. `raw` is git diff --raw; `collides` says a path holds
 * something untracked in the main tree.
 */
export function collectBlockers({ raw, collides }) {
  return raw.split('\n').filter(Boolean).flatMap((line) => {
    const [meta, file] = line.split('\t')
    const [, mode, , , status] = meta.split(' ')
    if (mode === '120000' || mode === '160000') return [`a link or submodule: ${file}`]
    const hit = status === 'A' ? parents(file).find(collides) : undefined
    return hit ? [`lands on untracked ${hit} in the main tree`] : []
  })
}

const countOf = (text, pattern) => (text.match(pattern) ?? []).length

/** The test count alone cannot see this: tests dev gained in the sync would hide a removal. */
export function weakenedTests(diff) {
  const added = countOf(diff, /^\+\s*(it|test)(\.\w+)?\(/gm)
  const removed = countOf(diff, /^-\s*(it|test)(\.\w+)?\(/gm)
  if (removed > added) return `${removed - added} test cases removed`
  const muted = /^\+.*\b(it|test|describe)\.(skip|only|todo)\(/m.exec(diff)
  return muted ? `a ${muted[2]} added` : null
}

export function mergeBlockers({ changed, dirty, branch }) {
  const onDev = branch === 'dev' ? [] : [`main tree is on ${branch}, not dev`]
  const overlap = changed.filter((file) => dirty.includes(file)).map((file) => `uncommitted in the main tree: ${file}`)
  const protectedFiles = changed.filter((file) => PROTECTED_FILES.test(file)).map((file) => `protected file changed: ${file}`)
  return [...onDev, ...overlap, ...protectedFiles]
}

function lanePath(current = '') {
  const kept = current.split(':').filter((dir) => dir && !/cookrew/i.test(dir))
  return ['/opt/homebrew/bin', ...kept.filter((dir) => dir !== '/opt/homebrew/bin')].join(':')
}

/** Nothing inherited may point at the running app, its panes or another account. */
export function laneEnv(env, { copilotHome, token, tmp } = {}) {
  const kept = Object.entries(env).filter(([name]) => KEPT_ENV.test(name))
  return {
    ...Object.fromEntries(kept),
    PATH: lanePath(env.PATH),
    ...(tmp ? { TMPDIR: tmp } : {}),
    ...(copilotHome ? { COPILOT_HOME: copilotHome } : {}),
    ...(token ? { COPILOT_GITHUB_TOKEN: token } : {})
  }
}

export function copilotArgs({ prompt, model }) {
  return [
    '-p', prompt,
    '--sandbox',
    '--disallow-temp-dir',
    '--allow-all-tools',
    '--secret-env-vars=COPILOT_GITHUB_TOKEN',
    ...DENIED_COMMANDS.map((command) => `--deny-tool=shell(${command})`),
    '--output-format', 'json',
    '--no-custom-instructions',
    '--disable-builtin-mcps',
    '--no-ask-user',
    '--no-auto-update',
    ...(model ? ['--model', model] : [])
  ]
}

function cutAtWord(text, limit) {
  return text.length <= limit ? text : text.slice(0, text.lastIndexOf(' ', limit))
}

export function summaryOf(message, taskId) {
  const lines = [...message.matchAll(/^SUMMARY:\s*(.+)$/gm)]
  const last = lines.at(-1)?.[1]?.trim()
  return last ? cutAtWord(last, 100) : `chore: daily copilot lane (${taskId})`
}

/** Measured: at load 8 a core tsc took over ten minutes instead of one. */
export function tooBusy({ load, cores }) {
  return load / cores > 3
}

export function parseListening(netstat) {
  const ports = [...netstat.matchAll(/[.:](\d+)\s+\S+\s+LISTEN\b/g)].map((match) => Number(match[1]))
  return [...new Set(ports)]
}

/**
 * The profile the gates run under, since a lane's tests are code it wrote. Passed
 * inline, never as a file a test could rewrite before the next run. The last
 * matching rule wins. A deny list over one user's account is containment, not a
 * wall; a separate macOS user would be the stronger form of this.
 */
export function gateProfile({ writable, readable, home, listening }) {
  const paths = (list) => list.map((dir) => `(subpath "${dir}")`).join(' ')
  const services = listening.map((port) => `(deny network-outbound (remote ip "localhost:${port}"))`).join('\n')
  return `(version 1)
(allow default)
(deny file-write*)
(allow file-write* ${paths(writable)} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/(tty|ttys|ptmx|fd/)"))
(deny file-read-data (subpath "${home}"))
(allow file-read-data ${paths(readable)})
(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))
(deny appleevent-send)
(deny signal)
(allow signal (target same-sandbox))
(deny network-outbound (remote ip "*:*"))
(allow network-outbound (remote ip "localhost:*"))
${services}
(deny network-outbound (subpath "/Users") (subpath "/private/var") (subpath "/private/tmp"))
(allow network-outbound ${paths(writable)})
`
}
