// WHAT KEEPS A FASTER CI THE SAME CI. The suite is split across runners and a
// Windows install is cached; neither may quietly drop a test, an OS, or a
// dependency change.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { POSTINSTALL_SCRIPTS, depsKey, versionlessLock } from '../scripts/ci-deps-key.mjs'
import { releaseBar } from '../scripts/copilot-daily-lib.mjs'

const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown }

type Step = { run?: string; if?: string; uses?: string; id?: string; with?: Record<string, unknown> }
type Job = {
  if?: string
  name?: string
  needs?: string | string[]
  'runs-on'?: string
  strategy?: { matrix?: { os?: string[]; shard?: number[] } }
  steps: Step[]
}
type Workflow = { concurrency?: { group: string; 'cancel-in-progress': string | boolean }; jobs: Record<string, Job> }

const load = (file: string): Workflow => yaml.load(readFileSync(file, 'utf8')) as Workflow
const ci = load('.github/workflows/ci.yml')
const release = load('.github/workflows/release.yml')

/** The step that runs the suite, and the N in its --shard=<i>/N. */
function shardedTest(job: Job): { step: Step; total: number } {
  const step = job.steps.find((s) => s.run?.startsWith('npm test')) as Step
  const total = Number(/--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/.exec(step?.run ?? '')?.[1])
  return { step, total }
}

describe('ci.yml', () => {
  const check = ci.jobs.check

  it('runs every shard of the suite on every OS', () => {
    expect(check.strategy?.matrix?.os).toEqual(['ubuntu-latest', 'macos-latest', 'windows-2022'])
    const { step, total } = shardedTest(check)
    expect(step).toBeDefined()
    expect(check.strategy?.matrix?.shard).toEqual(Array.from({ length: total }, (_, i) => i + 1))
  })

  it('typechecks and guards once, on Linux', () => {
    const runs = ci.jobs.static.steps.map((s) => s.run ?? '').join('\n')
    expect(ci.jobs.static['runs-on']).toBe('ubuntu-latest')
    expect(runs).toContain('npm run typecheck')
    expect(runs).toContain('maestri')
  })

  it('still builds the app once per OS, red tests or not', () => {
    const build = check.steps.find((s) => s.run === 'npm run build') as Step
    const test = check.steps.find((s) => s.run?.startsWith('npm test')) as Step
    expect(build.if).toBe(`\${{ !cancelled() && matrix.shard == 1 && steps.${test.id}.outcome != 'skipped' }}`)
  })

  // The patch release merges dev into main once this bar is green; a job it
  // does not name is a check a release can ship past.
  it('every job but Windows is in the release bar', () => {
    const names = ['static']
    for (const os of check.strategy?.matrix?.os ?? []) {
      for (const shard of check.strategy?.matrix?.shard ?? []) {
        names.push(String(check.name).replace('${{ matrix.os }}', os).replace('${{ matrix.shard }}', String(shard)))
      }
    }
    expect(Object.keys(ci.jobs).sort()).toEqual(['check', 'static'])
    const green = names.map((name) => ({ name, bucket: 'pass' }))
    expect(releaseBar(green)).toBe('passed')
    for (const name of names.filter((n) => !n.includes('windows'))) {
      const red = green.map((c) => (c.name === name ? { ...c, bucket: 'fail' } : c))
      expect(releaseBar(red), name).toBe('failed')
    }
  })

  it('installs unless the cached tree for exactly these dependencies was restored', () => {
    const cache = check.steps.find((s) => s.uses?.startsWith('actions/cache/restore')) as Step
    // Every OS: no condition on the restore, and the key is the tree's identity.
    expect(cache.if).toBeUndefined()
    expect(String(cache.with?.key)).toContain('steps.deps.outputs.key')
    expect(String(cache.with?.path)).toContain('node_modules')
    // macOS builds cr-listen outside node_modules; a restored tree carries it.
    expect(String(cache.with?.path)).toContain('resources/cr-listen/cr-listen')
    const install = check.steps.find((s) => s.run === 'npm ci') as Step
    expect(install.if).toBe(`steps.${cache.id}.outputs.cache-hit != 'true'`)
  })

  // actions/cache saves only from a green job; the Windows leg is not always
  // green, so the tree is saved explicitly, before the tests can touch it.
  it('saves a fresh install right after it, under the key it was restored by', () => {
    const steps = check.steps
    const cache = steps.find((s) => s.uses?.startsWith('actions/cache/restore')) as Step
    const save = steps.find((s) => s.uses?.startsWith('actions/cache/save')) as Step
    const install = steps.findIndex((s) => s.run === 'npm ci')
    const test = steps.findIndex((s) => s.run?.startsWith('npm test'))
    expect(save.with?.key).toBe(cache.with?.key)
    expect(save.with?.path).toBe(cache.with?.path)
    expect(save.if).toContain(`steps.${cache.id}.outputs.cache-hit != 'true'`)
    expect(save.if).toContain('matrix.shard == 1')
    expect(steps.indexOf(save)).toBe(install + 1)
    expect(steps.indexOf(save)).toBeLessThan(test)
    expect(steps.some((s) => s.uses === 'actions/cache@v4')).toBe(false)
  })

  // The CI caches are the installed trees: setup-node's npm download cache was
  // keyed on the raw lockfile, so every release left new copies behind.
  it('keeps no npm download cache beside the installed tree', () => {
    for (const job of [check, ci.jobs.static]) {
      const setup = job.steps.find((s) => s.uses?.startsWith('actions/setup-node')) as Step
      expect(setup.with?.cache).toBeUndefined()
    }
  })

  // static installs without scripts, which is not the tree the key names.
  it('lets static read the Linux tree and never write one', () => {
    const steps = ci.jobs.static.steps
    const restore = steps.find((s) => s.uses?.startsWith('actions/cache/restore')) as Step
    expect(restore.with?.key).toBe(check.steps.find((s) => s.uses?.startsWith('actions/cache/restore'))?.with?.key)
    expect(steps.some((s) => s.uses?.startsWith('actions/cache/save'))).toBe(false)
    const install = steps.find((s) => s.run === 'npm ci --ignore-scripts') as Step
    expect(install.if).toBe(`steps.${restore.id}.outputs.cache-hit != 'true'`)
  })

  it('cancels superseded pull request runs, never a push to main', () => {
    expect(ci.concurrency?.['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}")
    expect(ci.concurrency?.group).toBe('ci-${{ github.event.pull_request.number || github.run_id }}')
  })
})

describe('release.yml verify', () => {
  it('runs every shard of the suite before anything is built', () => {
    const verify = release.jobs.verify
    const { step, total } = shardedTest(verify)
    expect(step.if).toBeUndefined()
    expect(verify.strategy?.matrix?.shard).toEqual(Array.from({ length: total }, (_, i) => i + 1))
    expect(release.jobs.build.needs).toBe('verify')
  })

  // Owner ruling 2026-11-16: verify and the builds read the tree main's CI saved.
  it('reads the tree CI saved, under the same key, and never writes one', () => {
    const ciRestore = ci.jobs.check.steps.find((s) => s.uses?.startsWith('actions/cache/restore')) as Step
    for (const name of ['verify', 'build']) {
      const steps = release.jobs[name].steps
      const restore = steps.find((s) => s.uses?.startsWith('actions/cache/restore')) as Step
      expect(restore.with).toEqual(ciRestore.with)
      expect(steps.some((s) => s.uses?.startsWith('actions/cache/save') || s.uses?.startsWith('actions/cache@'))).toBe(false)
      const install = steps.find((s) => s.run === 'npm ci') as Step
      expect(install.if).toContain(`steps.${restore.id}.outputs.cache-hit != 'true'`)
      expect(steps.indexOf(install)).toBeGreaterThan(steps.indexOf(restore))
    }
  })

  // A tree saved where clang failed has no cr-listen; a release must carry it.
  it('installs on macOS when the restored tree lacks cr-listen', () => {
    const install = release.jobs.build.steps.find((s) => s.run === 'npm ci') as Step
    expect(install.if).toContain("runner.os == 'macOS' && hashFiles('resources/cr-listen/cr-listen') == ''")
  })

  it('never cancels or queues a tag run behind another', () => {
    expect(release.concurrency?.group).toContain('github.run_id')
    expect(release.concurrency?.['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}")
  })
})

describe('ci-deps-key', () => {
  const lock = {
    name: 'cookrew',
    version: '0.6.11',
    lockfileVersion: 3,
    packages: {
      '': { name: 'cookrew', version: '0.6.11', dependencies: { 'node-pty': '^1.1.0' } },
      'node_modules/node-pty': { version: '1.1.0' }
    }
  }
  const base = { lock, postinstall: 'electron-rebuild -f -w node-pty', scripts: ['a'], runtime: ['win32', 'x64', '127'] }

  it('a version bump alone keeps the key: no dependency changed', () => {
    const bumped = { ...lock, version: '0.7.0', packages: { ...lock.packages, '': { ...lock.packages[''], version: '0.7.0' } } }
    expect(depsKey({ ...base, lock: bumped })).toBe(depsKey(base))
    expect(versionlessLock(lock)).not.toHaveProperty('version')
  })

  // Each file postinstall runs or compiles: a cached tree must not outlive it.
  it('reads every input of the install it stands for', () => {
    expect(POSTINSTALL_SCRIPTS).toEqual(['scripts/ensure-node-pty.mjs', 'scripts/build-cr-listen.mjs', 'resources/cr-listen/cr-listen.m'])
    const postinstall = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts.postinstall
    for (const script of POSTINSTALL_SCRIPTS.filter((file) => file.startsWith('scripts/'))) expect(postinstall).toContain(script)
  })

  it('a dependency, the install scripts or the runtime each move the key', () => {
    const upgraded = { ...lock, packages: { ...lock.packages, 'node_modules/node-pty': { version: '1.2.0' } } }
    expect(depsKey({ ...base, lock: upgraded })).not.toBe(depsKey(base))
    expect(depsKey({ ...base, scripts: ['b'] })).not.toBe(depsKey(base))
    expect(depsKey({ ...base, postinstall: 'other' })).not.toBe(depsKey(base))
    expect(depsKey({ ...base, runtime: ['win32', 'x64', '131'] })).not.toBe(depsKey(base))
  })

  it('does not change the lockfile it reads', () => {
    const before = JSON.stringify(lock)
    versionlessLock(lock)
    expect(JSON.stringify(lock)).toBe(before)
  })
})

describe('perf.yml on pull requests', () => {
  type PerfOn = { schedule?: unknown; workflow_dispatch?: unknown; pull_request?: { paths?: string[] } }
  const workflow = yaml.load(readFileSync('.github/workflows/perf.yml', 'utf8')) as {
    on: PerfOn
    jobs: { gates: { strategy: { matrix: { os: string } } } }
  }
  const perf = workflow.on

  // Owner ruling 2026-11-16: a PR that changes the app runs the gates again.
  it('runs on a PR that changes the gates or the app they measure', () => {
    expect(perf.pull_request?.paths).toEqual(
      expect.arrayContaining(['tests/perf/**', 'vitest.perf.config.ts', 'src/renderer/**', 'src/main/**', 'registry/**'])
    )
  })

  // ...on Linux only, so it takes no macOS slot from CI; macOS runs nightly.
  it('runs Linux alone on a PR, both OSes otherwise', () => {
    const os = workflow.jobs.gates.strategy.matrix.os
    expect(os).toContain("github.event_name == 'pull_request'")
    expect(os).toContain(`fromJSON('["ubuntu-latest"]')`)
    expect(os).toContain(`fromJSON('["ubuntu-latest", "macos-latest"]')`)
  })

  it('keeps the nightly and the manual run', () => {
    expect(perf.schedule).toBeDefined()
    expect(perf).toHaveProperty('workflow_dispatch')
  })
})
