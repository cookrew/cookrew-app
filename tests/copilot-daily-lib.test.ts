import { describe, expect, it } from 'vitest'
import {
  acceptLane,
  collectBlockers,
  copilotArgs,
  dailyBudget,
  gateProfile,
  hardCap,
  laneEnv,
  mergeBlockers,
  missingAssets,
  nextPatch,
  ownerTask,
  parseListening,
  parseQuota,
  parseTscErrors,
  parseVitestFailures,
  pickTask,
  releaseBar,
  releaseStage,
  summaryOf,
  tooBusy,
  trustedIssues,
  typeFailures,
  vitestOutcome,
  weakenedTests
} from '../scripts/copilot-daily-lib.mjs'

const NOW = new Date('2026-11-04T16:00:00Z')

describe('the day’s budget spends the month evenly', () => {
  it('divides what is left by the days until the reset', () => {
    expect(dailyBudget({ remaining: 1482, resetDate: '2026-12-01', now: NOW })).toBe(54)
  })

  it('gives the whole remainder on the last day, so nothing is left unused', () => {
    const lastDay = new Date('2026-11-30T20:00:00Z')
    expect(dailyBudget({ remaining: 300, resetDate: '2026-12-01', now: lastDay })).toBe(300)
  })

  it('is zero when nothing is left', () => {
    expect(dailyBudget({ remaining: 0, resetDate: '2026-12-01', now: NOW })).toBe(0)
  })

  it('lets one session run past the share by half, because tomorrow re-divides', () => {
    expect(hardCap(54, 1400)).toBe(81)
  })

  it('never reaches past what is left, which is the whole share on the last day', () => {
    expect(hardCap(300, 300)).toBe(300)
  })
})

describe('reading the quota answer', () => {
  it('takes the premium snapshot and the reset date', () => {
    const quota = parseQuota({
      quota_reset_date: '2026-12-01',
      quota_snapshots: { premium_interactions: { remaining: 1482, entitlement: 1500 } }
    })
    expect(quota).toEqual({ remaining: 1482, entitlement: 1500, resetDate: '2026-12-01' })
  })

  it('refuses an account with no premium snapshot rather than reading it as zero', () => {
    expect(() => parseQuota({ message: 'Bad credentials' })).toThrow(/premium/)
  })

  it('reads a full timestamp as its date', () => {
    const answer = {
      quota_reset_date: '2026-12-01T00:00:00.000Z',
      quota_snapshots: { premium_interactions: { remaining: 1, entitlement: 2 } }
    }
    expect(parseQuota(answer).resetDate).toBe('2026-12-01')
  })

  it('refuses a number or date it cannot trust, since NaN would pass every budget check', () => {
    const snapshot = { premium_interactions: { remaining: 1, entitlement: 2 } }
    expect(() => parseQuota({ quota_snapshots: snapshot })).toThrow(/reset date/)
    expect(() =>
      parseQuota({ quota_reset_date: '2026-12-01', quota_snapshots: { premium_interactions: {} } })
    ).toThrow(/remaining/)
  })
})

describe('the patch version', () => {
  it('moves only the last number', () => {
    expect(nextPatch('0.4.0')).toBe('0.4.1')
    expect(nextPatch('1.9.9')).toBe('1.9.10')
  })

  it('refuses anything that is not plain x.y.z', () => {
    expect(() => nextPatch('0.4.0-beta')).toThrow(/version/)
  })
})

describe('where a release picks up', () => {
  const state = { tags: ['v0.4.0'], published: ['v0.4.0'], mainVersion: '0.4.0' }

  it('starts the next patch once the current version is public', () => {
    expect(releaseStage({ ...state, version: '0.4.0' })).toEqual({ version: '0.4.1', stage: 'bump' })
  })

  it('resumes the pull request for a bumped version not yet on main', () => {
    expect(releaseStage({ ...state, version: '0.4.1' })).toEqual({ version: '0.4.1', stage: 'pr' })
  })

  it('tags a version that reached main and stopped there', () => {
    const merged = { ...state, version: '0.4.1', mainVersion: '0.4.1' }
    expect(releaseStage(merged)).toEqual({ version: '0.4.1', stage: 'tag' })
  })

  it('finishes a tagged version that never went public, instead of cutting another', () => {
    const tagged = { ...state, version: '0.4.1', mainVersion: '0.4.1', tags: ['v0.4.0', 'v0.4.1'] }
    expect(releaseStage(tagged)).toEqual({ version: '0.4.1', stage: 'draft' })
  })
})

describe('the assets a public release needs', () => {
  it('names what is missing', () => {
    expect(missingAssets(['Cookrew-0.4.1-arm64.dmg'])).toEqual(['.exe'])
  })

  it('passes with an installer for each platform', () => {
    expect(missingAssets(['a.dmg', 'b.exe', 'latest.yml'])).toEqual([])
  })
})

describe('the release bar', () => {
  const checks = (ubuntu: string, macos: string) => [
    { name: 'check (ubuntu-latest)', bucket: ubuntu },
    { name: 'check (macos-latest)', bucket: macos },
    { name: 'check (windows-2022)', bucket: 'fail' },
    { name: 'gates (ubuntu-latest)', bucket: 'fail' }
  ]

  it('needs mac and ubuntu, and looks past Windows and the perf gates', () => {
    expect(releaseBar(checks('pass', 'pass'))).toBe('passed')
  })

  it('waits while one is running', () => {
    expect(releaseBar(checks('pass', 'pending'))).toBe('pending')
  })

  it('fails on either', () => {
    expect(releaseBar(checks('fail', 'pass'))).toBe('failed')
  })

  it('waits when the checks have not been created yet', () => {
    expect(releaseBar([])).toBe('pending')
  })
})

describe('reading the gates', () => {
  it('names each failed vitest case by file and title', () => {
    const report = {
      testResults: [
        {
          name: '/wt/tests/a.test.ts',
          assertionResults: [
            { status: 'passed', fullName: 'ok' },
            { status: 'failed', fullName: 'the card opens' }
          ]
        }
      ]
    }
    expect(parseVitestFailures(report, '/wt')).toEqual(['tests/a.test.ts > the card opens'])
  })

  it('counts a suite that failed to load, which has no cases to report', () => {
    const report = {
      testResults: [{ name: '/wt/tests/b.test.ts', status: 'failed', assertionResults: [] }]
    }
    expect(parseVitestFailures(report, '/wt')).toEqual(['tests/b.test.ts > (suite failed to load)'])
  })

  it('names tsc errors by file and code, without the moving line number', () => {
    const out = "tests/h.test.tsx(119,8): error TS2741: Property 'orch' is missing\nnoise\n"
    expect(parseTscErrors(out)).toEqual(["tests/h.test.tsx TS2741: Property 'orch' is missing"])
  })

  it('counts what ran, so a removed test shows', () => {
    const report = { success: true, numPassedTests: 8, numFailedTests: 1, testResults: [] }
    expect(vitestOutcome(report, '/wt').active).toBe(9)
  })

  it('does not read a run of nothing as green', () => {
    const report = { success: true, numPassedTests: 0, numFailedTests: 0, testResults: [] }
    expect(vitestOutcome(report, '/wt').failures).toHaveLength(1)
  })

  it('does not read a failed run with no failing case as green', () => {
    const report = { success: false, numPassedTests: 5, numFailedTests: 0, testResults: [] }
    expect(vitestOutcome(report, '/wt').failures).toHaveLength(1)
  })

  it('counts a tsc that died as a failure, not as clean', () => {
    const died = typeFailures({ ok: false, output: 'FATAL ERROR: heap out of memory', config: 'tsconfig.web.json' })
    expect(died).toEqual(['tsconfig.web.json: tsc did not finish'])
  })

  it('is clean only when tsc exits clean', () => {
    expect(typeFailures({ ok: true, output: '', config: 'tsconfig.web.json' })).toEqual([])
  })
})

describe('which issues a lane may read', () => {
  const by = (login: string, number: number) => ({ number, title: 't', body: 'b', author: { login } })

  it('takes only the owner’s, because the repo is public and the text becomes a prompt', () => {
    expect(trustedIssues([by('favon24', 1), by('stranger', 2)], []).map((i) => i.number)).toEqual([1])
  })

  it('leaves an issue already tried, so one hard issue cannot eat every day', () => {
    expect(trustedIssues([by('favon24', 1), by('favon24', 2)], ['issue-1']).map((i) => i.number)).toEqual([2])
  })
})

describe('choosing the day’s task', () => {
  const issue = { number: 12, title: 'note lands in the wrong place', body: 'steps' }

  it('puts a red dev before everything', () => {
    const task = pickTask({ failures: ['tests/a.test.ts > x'], issues: [issue], day: 3 })
    expect(task.id).toBe('green')
    expect(task.brief).toContain('tests/a.test.ts > x')
  })

  it('takes a labelled issue next, oldest first', () => {
    const older = { number: 5, title: 'older', body: '' }
    const task = pickTask({ failures: [], issues: [issue, older], day: 3 })
    expect(task.id).toBe('issue-5')
    expect(task.brief).toContain('older')
  })

  it('rotates the standing chores by day', () => {
    const ids = [0, 1, 2].map((day) => pickTask({ failures: [], issues: [], day }).id)
    expect(new Set(ids).size).toBe(3)
  })

  it('carries the lane rules in every brief', () => {
    const task = pickTask({ failures: [], issues: [], day: 0 })
    expect(task.brief).toContain('Never start the app')
    expect(task.brief).toContain('SUMMARY:')
  })
})

describe('the owner’s own brief', () => {
  it('carries the same lane rules as the queue', () => {
    const task = ownerTask('fix the dock')
    expect(task.id).toBe('owner')
    expect(task.brief).toContain('fix the dock')
    expect(task.brief).toContain('Never start the app')
  })
})

describe('accepting a lane', () => {
  const run = (failures: string[], active = 100) => ({ failures, active })

  it('takes a lane that clears failures and adds none', () => {
    const verdict = acceptLane({ before: run(['a', 'b']), after: run(['a']), mustClear: true })
    expect(verdict.ok).toBe(true)
  })

  it('takes a lane that stays green', () => {
    expect(acceptLane({ before: run([]), after: run([]), mustClear: false }).ok).toBe(true)
  })

  it('refuses a new failure even when others were cleared', () => {
    const verdict = acceptLane({ before: run(['a', 'b']), after: run(['c']), mustClear: true })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('c')
  })

  it('refuses a green-task lane that cleared nothing', () => {
    expect(acceptLane({ before: run(['a']), after: run(['a']), mustClear: true }).ok).toBe(false)
  })

  it('lets the owner’s own task land on a dev that was already red', () => {
    expect(acceptLane({ before: run(['a']), after: run(['a']), mustClear: false }).ok).toBe(true)
  })

  it('refuses a lane that made a failure go away by removing or skipping the test', () => {
    const verdict = acceptLane({ before: run(['a'], 100), after: run([], 99), mustClear: true })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/fewer tests/)
  })
})

describe('what stops a merge into dev', () => {
  it('passes a lane that shares nothing with the main tree', () => {
    const blockers = mergeBlockers({ changed: ['tests/a.test.ts'], dirty: ['src/b.ts'], branch: 'dev' })
    expect(blockers).toEqual([])
  })

  it('stops on a file the owner has uncommitted', () => {
    const blockers = mergeBlockers({ changed: ['src/b.ts'], dirty: ['src/b.ts'], branch: 'dev' })
    expect(blockers.join()).toContain('src/b.ts')
  })

  it('stops on dependency files, since the running app shares that tree', () => {
    const blockers = mergeBlockers({ changed: ['package-lock.json'], dirty: [], branch: 'dev' })
    expect(blockers.join()).toContain('package-lock.json')
  })

  it('stops on the files that decide what the gates mean or what runs unattended', () => {
    const risky = ['.github/workflows/ci.yml', 'scripts/copilot-daily.mjs', 'vitest.config.ts', 'tsconfig.web.json', '.gitignore']
    const blockers = mergeBlockers({ changed: risky, dirty: [], branch: 'dev' })
    expect(blockers).toHaveLength(risky.length)
  })

  it('sees a protected file at any depth and the code that runs unsandboxed', () => {
    const changed = ['tests/.gitignore', 'electron.vite.config.ts', 'scripts/postinstall.mjs']
    expect(mergeBlockers({ changed, dirty: [], branch: 'dev' })).toHaveLength(3)
  })

  it('stops when the main tree is not on dev', () => {
    const blockers = mergeBlockers({ changed: ['a.ts'], dirty: [], branch: 'feat/x' })
    expect(blockers.join()).toContain('feat/x')
  })
})

describe('the lane’s environment', () => {
  const env = {
    PATH: '/var/folders/x/T/cookrew-runtime:/Users/me/.cookrew/bin:/usr/bin',
    HOME: '/Users/me',
    COOKREW_TERMINAL_ID: 'x',
    HERDR_SOCKET_PATH: '/s',
    TERM_PROGRAM: 'Cookrew',
    GH_TOKEN: 'secret',
    GITHUB_TOKEN: 'secret',
    LANG: 'en_US.UTF-8'
  }

  it('drops everything that could reach the running app or a second account', () => {
    const scrubbed = laneEnv(env, { copilotHome: '/h', token: 't' })
    expect(Object.keys(scrubbed).sort()).toEqual(
      ['COPILOT_GITHUB_TOKEN', 'COPILOT_HOME', 'HOME', 'LANG', 'PATH'].sort()
    )
  })

  it('keeps by allow list, so a credential it has never heard of stays out', () => {
    const scrubbed = laneEnv({ ...env, GEMINI_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'k', SSH_AUTH_SOCK: '/s' })
    expect(Object.keys(scrubbed)).not.toEqual(expect.arrayContaining(['GEMINI_API_KEY']))
    expect(scrubbed).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(scrubbed).not.toHaveProperty('SSH_AUTH_SOCK')
  })

  it('takes the Cookrew tool directories off PATH and keeps Homebrew on it', () => {
    const { PATH } = laneEnv(env, { copilotHome: '/h', token: 't' })
    expect(PATH).not.toContain('cookrew')
    expect(PATH.split(':')).toContain('/opt/homebrew/bin')
  })

  it('leaves the token out when the gates run, which need no account', () => {
    const scrubbed = laneEnv(env, {})
    expect(scrubbed).not.toHaveProperty('COPILOT_GITHUB_TOKEN')
  })
})

describe('the copilot command line', () => {
  const args = copilotArgs({ prompt: 'do it', model: 'claude-sonnet-5.5' })

  it('runs sandboxed with the token masked', () => {
    expect(args).toContain('--sandbox')
    expect(args).toContain('--secret-env-vars=COPILOT_GITHUB_TOKEN')
  })

  it('denies the commands that leave the lane', () => {
    for (const rule of ['shell(git push)', 'shell(git stash)', 'shell(npm install)', 'shell(gh:*)']) {
      expect(args).toContain(`--deny-tool=${rule}`)
    }
  })

  it('omits the model flag when none is set, so the account default holds', () => {
    expect(copilotArgs({ prompt: 'x' }).join(' ')).not.toContain('--model')
  })
})

describe('the gate’s sandbox profile', () => {
  const profile = gateProfile({
    writable: ['/wt/tree', '/wt/tmp'],
    readable: ['/wt/tree', '/repo/.git'],
    home: '/Users/me',
    listening: [7897, 9333]
  })

  it('allows writes only where it was told, and not all of /tmp', () => {
    expect(profile).toContain('(deny file-write*)')
    expect(profile).toContain('(allow file-write* (subpath "/wt/tree") (subpath "/wt/tmp")')
    const writes = profile.split('\n').filter((line) => line.startsWith('(allow file-write*'))
    expect(writes.join()).not.toContain('/private/tmp')
  })

  it('reads nothing of the home directory but what it was given', () => {
    expect(profile).toContain('(deny file-read-data (subpath "/Users/me"))')
    expect(profile).toContain('(allow file-read-data (subpath "/wt/tree") (subpath "/repo/.git"))')
  })

  it('reaches no service on this Mac, loopback or socket, and no keychain', () => {
    expect(profile).toContain('(deny network-outbound (remote ip "localhost:7897"))')
    expect(profile).toContain('(deny network-outbound (remote ip "localhost:9333"))')
    expect(profile).toContain('(deny network-outbound (remote ip "*:*"))')
    expect(profile).toContain('com.apple.SecurityServer')
  })

  it('touches no other process', () => {
    expect(profile).toContain('(deny signal)')
    expect(profile).toContain('(allow signal (target same-sandbox))')
  })
})

describe('the ports the gate walls off', () => {
  it('reads every listener, root’s included, once each', () => {
    const netstat = [
      'tcp4       0      0  127.0.0.1.7897         *.*                    LISTEN',
      'tcp46      0      0  *.8639                 *.*                    LISTEN',
      'tcp6       0      0  ::1.9333               *.*                    LISTEN',
      'tcp4       0      0  127.0.0.1.7897         *.*                    LISTEN',
      'tcp4       0      0  10.0.0.2.50000         1.1.1.1.443            ESTABLISHED'
    ].join('\n')
    expect(parseListening(netstat)).toEqual([7897, 8639, 9333])
  })
})

describe('a machine too busy to gate on', () => {
  it('waits at the load that took tsc past ten minutes', () => {
    expect(tooBusy({ load: 84, cores: 10 })).toBe(true)
  })

  it('runs on an ordinary day of fleet work', () => {
    expect(tooBusy({ load: 20, cores: 10 })).toBe(false)
  })
})

describe('what a lane may not hand over', () => {
  const raw = (mode: string, file: string, status = 'A'): string =>
    `:000000 ${mode} ${'0'.repeat(40)} ${'1'.repeat(40)} ${status}\t${file}`
  const nothingThere = (): boolean => false

  it('passes ordinary files', () => {
    expect(collectBlockers({ raw: raw('100644', 'tests/a.test.ts'), collides: nothingThere })).toEqual([])
  })

  it('refuses a symlink, which replaced node_modules through a clean merge', () => {
    const blockers = collectBlockers({ raw: raw('120000', 'node_modules'), collides: nothingThere })
    expect(blockers.join()).toContain('node_modules')
  })

  it('refuses a gitlink', () => {
    expect(collectBlockers({ raw: raw('160000', 'vendor/x'), collides: nothingThere })).toHaveLength(1)
  })

  it('refuses a new path that lands on something untracked in the main tree', () => {
    const collides = (file: string): boolean => file === 'out'
    expect(collectBlockers({ raw: raw('100644', 'out'), collides }).join()).toContain('out')
  })

  it('checks each parent of a new path', () => {
    const collides = (file: string): boolean => file === 'docs'
    expect(collectBlockers({ raw: raw('100644', 'docs/x/y.md'), collides })).toHaveLength(1)
  })

  it('leaves a modified file alone, which is the point of a lane', () => {
    const collides = (): boolean => true
    expect(collectBlockers({ raw: raw('100644', 'src/a.ts', 'M'), collides })).toEqual([])
  })
})

describe('weakening the tests', () => {
  it('sees a test case removed', () => {
    expect(weakenedTests("-  it('works', () => {\n-    expect(1).toBe(1)\n-  })\n")).toMatch(/removed/)
  })

  it('sees a skip or only added', () => {
    expect(weakenedTests("+  it.skip('works', () => {\n")).toMatch(/skip/)
    expect(weakenedTests("+  describe.only('all', () => {\n")).toMatch(/only/)
  })

  it('lets a test be moved or rewritten', () => {
    expect(weakenedTests("-  it('old name', () => {\n+  it('new name', () => {\n")).toBeNull()
  })

  it('lets tests be added', () => {
    expect(weakenedTests("+  it('new', () => {\n")).toBeNull()
  })
})

describe('the commit subject', () => {
  it('takes the SUMMARY line from the last message', () => {
    expect(summaryOf('did things\nSUMMARY: fix: the harness menu test passes orch\n', 'green')).toBe(
      'fix: the harness menu test passes orch'
    )
  })

  it('cuts a long subject at a word, not inside one', () => {
    const long = `SUMMARY: fix: ${'word '.repeat(40)}`
    const subject = summaryOf(long, 'green')
    expect(subject.length).toBeLessThanOrEqual(100)
    expect(subject.endsWith('word')).toBe(true)
  })

  it('falls back to the task when the session never said', () => {
    expect(summaryOf('killed mid-way', 'green')).toBe('chore: daily copilot lane (green)')
  })
})
