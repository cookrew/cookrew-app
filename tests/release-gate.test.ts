// WHAT MUST BE TRUE BEFORE A RELEASE GOES OUT. Publishing is what puts a build
// in front of every running app, so it happens only after these pass.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { isPrerelease, missingAssets, tagProblem } from '../scripts/release-gate.mjs'

const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown }

describe('tagProblem', () => {
  it('a tag naming the package version is fine', () => {
    expect(tagProblem('v0.5.0', '0.5.0')).toBeNull()
    expect(tagProblem('v0.5.0-beta.1', '0.5.0-beta.1')).toBeNull()
  })

  it('names the mismatch: a build would report a version the feed does not', () => {
    expect(tagProblem('v0.5.0', '0.4.0')).toContain('0.4.0')
  })

  it('refuses a tag that is no version', () => {
    expect(tagProblem('nightly', '0.5.0')).not.toBeNull()
  })
})

describe('missingAssets', () => {
  const all = ['latest-mac.yml', 'latest.yml', 'Cookrew-0.5.0-arm64-mac.zip', 'Cookrew-0.5.0-arm64.dmg', 'Cookrew-0.5.0-windows-preview-x64.exe']

  it('passes a release holding what the updater reads and what people download', () => {
    expect(missingAssets(all, '0.5.0')).toEqual([])
  })

  it('names what is missing: without a feed file, no app ever hears of the release', () => {
    expect(missingAssets(all.filter((name) => name !== 'latest-mac.yml'), '0.5.0')).toEqual(['latest-mac.yml'])
  })

  it('assets of another version do not count', () => {
    expect(missingAssets(all, '0.6.0')).toContain('Cookrew-0.6.0-arm64-mac.zip')
  })
})

describe('isPrerelease', () => {
  it('a suffix keeps a release away from everyone’s updater', () => {
    expect(isPrerelease('v0.5.0-beta.1')).toBe(true)
    expect(isPrerelease('v0.5.0')).toBe(false)
  })
})

describe('release.yml', () => {
  type Job = { if?: string; needs?: string | string[]; steps: Array<{ run?: string; name?: string }> }
  const { jobs } = yaml.load(readFileSync('.github/workflows/release.yml', 'utf8')) as { jobs: Record<string, Job> }
  const runs = (job: Job): string => job.steps.map((step) => step.run ?? '').join('\n')

  it('a tag runs the tests and the version check before anything is built', () => {
    expect(jobs.verify.if).toContain("startsWith(github.ref, 'refs/tags/')")
    expect(runs(jobs.verify)).toContain('npm test')
    expect(runs(jobs.verify)).toContain('npm run typecheck')
    expect(runs(jobs.verify)).toContain('scripts/release-gate.mjs tag')
    expect(jobs.build.needs).toBe('verify')
  })

  it('still builds a dispatch or a pull request, which skip the tag checks', () => {
    expect(jobs.build.if).toContain("needs.verify.result == 'skipped'")
  })

  it('publishes on a tag, only after every build, and only with the assets in place', () => {
    expect(jobs.publish.needs).toBe('build')
    expect(jobs.publish.if).toContain("startsWith(github.ref, 'refs/tags/')")
    const script = runs(jobs.publish)
    expect(script.indexOf('scripts/release-gate.mjs assets')).toBeGreaterThanOrEqual(0)
    expect(script.indexOf('scripts/release-gate.mjs assets')).toBeLessThan(script.indexOf('gh release edit'))
  })
})

describe('electron-builder.yml', () => {
  it('names the feed, so a packaged app knows where to look', () => {
    const builder = yaml.load(readFileSync('electron-builder.yml', 'utf8')) as { publish?: unknown }
    expect(builder.publish).toEqual({ provider: 'github', owner: 'cookrew', repo: 'cookrew-app' })
  })
})
