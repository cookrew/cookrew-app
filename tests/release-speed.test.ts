import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown }

type Step = { id?: string; uses?: string; run?: string; if?: string; with?: Record<string, string> }
type Job = { needs?: string | string[]; if?: string; strategy?: { matrix: { task: (number | string)[] } }; steps: Step[] }
type Workflow = { jobs: Record<string, Job> }
const workflow = (name: string) => yaml.load(readFileSync(`.github/workflows/${name}.yml`, 'utf8')) as Workflow
const { verify, build } = workflow('release').jobs
const { check } = workflow('ci').jobs
const actionPath = './.github/actions/restore-installed-deps'

it('partitions the whole suite, with a separate typecheck, before either installer builds', () => {
  const test = verify.steps.find((step) => step.run?.startsWith('npm test'))
  const count = Number(test?.run?.match(/\/(\d+)$/)?.[1])
  expect(count).toBeGreaterThan(1)
  expect(verify.strategy?.matrix.task).toEqual(['typecheck', ...Array.from({ length: count }, (_, i) => i + 1)])
  expect(test).toMatchObject({ run: `npm test -- --shard=\${{ matrix.task }}/${count}`, if: "matrix.task != 'typecheck'" })
  expect(verify.steps.find((step) => step.run === 'npm run typecheck')?.if).toBe("matrix.task == 'typecheck'")
  // After verify, and after the tag's one draft (release-gate.test.ts): never beside the tests.
  expect(build.needs).toEqual(['verify', 'draft'])
  expect(build.if).toContain("!startsWith(github.ref, 'refs/tags/') && needs.verify.result == 'skipped'")
})

it('restores only exact installed trees, with CI alone saving after a real install on pushes to main', () => {
  const composite = yaml.load(readFileSync(`${actionPath}/action.yml`, 'utf8')) as { runs: { steps: Step[] } }
  const [key, restore, smoke] = composite.runs.steps
  expect(key.run).toBe('node scripts/ci-installed-deps-key.mjs')
  expect(restore.uses).toMatch(/^actions\/cache\/restore@/)
  expect(restore.with?.['restore-keys']).toBeUndefined()
  expect(restore.with?.path).toBe('node_modules')
  expect(smoke.if).toBe("steps.restore.outputs.cache-hit == 'true'")
  expect(smoke.run).toContain('node scripts/check-installed-deps.mjs')
  for (const job of [check, verify, build]) {
    const deps = job.steps.find((step) => step.uses === actionPath)
    const install = job.steps.findIndex((step) => step.run === 'npm ci')
    expect(deps?.id).toBe('deps')
    expect(job.steps[install]?.if).toBe("steps.deps.outputs.cache-hit != 'true'")
    expect(job.steps.indexOf(deps!)).toBeLessThan(install)
    const saves = job.steps.filter((step) => step.uses?.startsWith('actions/cache/save@'))
    if (job === check) {
      expect(saves).toHaveLength(1)
      expect(saves[0]).toMatchObject({
        if: "github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.deps.outputs.restored != 'true'",
        with: { key: '${{ steps.deps.outputs.key }}', path: restore.with?.path }
      })
      expect(job.steps[install + 1]?.run).toBe('node scripts/check-installed-deps.mjs')
      expect(job.steps.indexOf(saves[0])).toBe(install + 2)
    } else expect(saves).toHaveLength(0)
  }
})

it('uploads already-compressed installers without compressing them again', () => {
  const archive = build.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))
  expect(archive?.with?.['compression-level']).toBe(0)
  expect(archive?.with?.['if-no-files-found']).toBe('error')
})

it('builds both macOS helpers on cache hits and still requires them before packaging', () => {
  for (const helper of ['cr-listen', 'cr-disclaim']) {
    const compile = build.steps.findIndex((step) => step.run?.includes(`node scripts/build-${helper}.mjs`))
    const require = build.steps.findIndex((step) => step.run === `test -x resources/${helper}/${helper}`)
    expect(compile).toBeGreaterThanOrEqual(0)
    expect(build.steps[compile].if).toContain('cache-hit')
    expect(require).toBeGreaterThan(compile)
    expect(require).toBeLessThan(build.steps.findIndex((step) => step.id === 'signing'))
  }
})

describe('installed dependency key', () => {
  const script = resolve('scripts/ci-installed-deps-key.mjs')
  const manifest = { name: 'cookrew', version: '1.2.3', dependencies: { alpha: '1.0.0' }, scripts: { postinstall: 'node scripts/build-cr-listen.mjs' } }
  const lock = { ...manifest, lockfileVersion: 3, packages: { '': { ...manifest }, 'node_modules/alpha': { version: '1.0.0' } } }

  it('ignores an app version bump but invalidates on dependency, install input, and image changes', () => {
    const cwd = mkdtempSync(resolve(tmpdir(), 'cookrew-ci-key-'))
    try {
      const manifestPath = resolve(cwd, 'package.json')
      const lockPath = resolve(cwd, 'package-lock.json')
      const put = (path: string, value: object) => writeFileSync(path, JSON.stringify(value))
      // Child-process env keys are case-insensitive on Windows. Strip GitHub's
      // originals before supplying fixtures so ImageOs cannot mask ImageOS.
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
        !['imageos', 'imageversion', 'github_output'].includes(name.toLowerCase())
      )))
      const key = (image = 'image-a', imageVersion = '20261123.1') => execFileSync(process.execPath, [script], {
        cwd, encoding: 'utf8', env: { ...env, ImageOS: image, ImageVersion: imageVersion }
      }).trim()
      const scripts = resolve(cwd, 'scripts')
      mkdirSync(scripts)
      const postinstall = resolve(scripts, 'build-cr-listen.mjs')
      writeFileSync(postinstall, '// initial install script\n')
      put(manifestPath, manifest)
      put(lockPath, lock)
      const original = key()
      expect(original).toMatch(/^key=.+[a-f0-9]{64}$/)
      put(manifestPath, { ...manifest, version: '1.2.4' })
      put(lockPath, { ...lock, version: '1.2.4', packages: { ...lock.packages, '': { ...manifest, version: '1.2.4' } } })
      expect(key()).toBe(original)
      expect(key('image-b')).not.toBe(original)
      expect(key('image-a', '20261123.2')).not.toBe(original)
      put(manifestPath, { ...manifest, dependencies: { alpha: '2.0.0' } })
      expect(key()).not.toBe(original)
      put(manifestPath, manifest)
      writeFileSync(postinstall, '// changed install script\n')
      expect(key()).not.toBe(original)
      writeFileSync(postinstall, '// initial install script\n')
      writeFileSync(resolve(cwd, '.npmrc'), 'legacy-peer-deps=true\n')
      expect(key()).not.toBe(original)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
