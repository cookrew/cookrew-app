// WHAT KEEPS A FASTER CI THE SAME CI. The suite is split across runners and a
// Windows install is cached; neither may quietly drop a test, an OS, or a
// dependency change.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { depsKey, versionlessLock } from '../scripts/ci-deps-key.mjs'

const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown }

type Step = { run?: string; if?: string; uses?: string; id?: string; with?: Record<string, unknown> }
type Job = {
  if?: string
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

  it('still builds the app once per OS', () => {
    const build = check.steps.find((s) => s.run === 'npm run build') as Step
    expect(build.if).toBe('matrix.shard == 1')
  })

  it('installs unless the cached tree for exactly these dependencies was restored', () => {
    const cache = check.steps.find((s) => s.uses?.startsWith('actions/cache/restore')) as Step
    expect(cache.if).toBe("runner.os == 'Windows'")
    expect(String(cache.with?.key)).toContain('steps.deps.outputs.key')
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
    expect(save.if).toContain(`steps.${cache.id}.outputs.cache-hit != 'true'`)
    expect(steps.indexOf(save)).toBe(install + 1)
    expect(steps.indexOf(save)).toBeLessThan(test)
    expect(steps.some((s) => s.uses === 'actions/cache@v4')).toBe(false)
  })

  it('cancels superseded pull request runs, never a push to main', () => {
    expect(ci.concurrency?.['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}")
    expect(ci.concurrency?.group).toContain('github.event.pull_request.number')
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
