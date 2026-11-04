import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * scripts/mac-signing-plan.mjs decides, from which secrets EXIST, how the macOS
 * job builds. It runs on GitHub, where the one path a repo with no certificate
 * can never rehearse is the signed one, so the decision is tested here by
 * running the script exactly as the workflow does: presence flags in the
 * environment, answers in the GITHUB_OUTPUT and GITHUB_STEP_SUMMARY files.
 */

const SCRIPT = path.resolve(__dirname, '../scripts/mac-signing-plan.mjs')

const CERT = { HAS_CSC_LINK: 'true', HAS_CSC_KEY_PASSWORD: 'true' }
const API_KEY = { HAS_APPLE_API_KEY_P8: 'true', HAS_APPLE_API_KEY_ID: 'true', HAS_APPLE_API_ISSUER: 'true' }
const APPLE_ID = { HAS_APPLE_ID: 'true', HAS_APPLE_APP_SPECIFIC_PASSWORD: 'true', HAS_APPLE_TEAM_ID: 'true' }

describe('mac-signing-plan', () => {
  let dir: string

  const plan = (flags: Record<string, string> = {}, event = 'push') => {
    const output = path.join(dir, 'output')
    const summary = path.join(dir, 'summary')
    writeFileSync(output, '')
    writeFileSync(summary, '')
    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, GITHUB_EVENT_NAME: event, ...flags }
    })
    const answers = Object.fromEntries(
      readFileSync(output, 'utf8')
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => line.split('=') as [string, string])
    )
    return { code: result.status, stdout: result.stdout, summary: readFileSync(summary, 'utf8'), ...answers }
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'signing-plan-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  describe('with no secrets at all', () => {
    it('builds unsigned and the job stays green', () => {
      const result = plan()
      expect(result.code).toBe(0)
      expect(result).toMatchObject({ mode: 'unsigned', sign: 'false', notarize: 'none' })
    })

    it('says so loudly, in the summary and as an annotation', () => {
      const result = plan()
      expect(result.summary).toMatch(/NOT signed/)
      expect(result.summary).toMatch(/Gatekeeper/)
      expect(result.stdout).toMatch(/^::warning/m)
    })

    it('names every secret the owner has to add', () => {
      const { summary } = plan()
      for (const name of [
        'CSC_LINK',
        'CSC_KEY_PASSWORD',
        'APPLE_API_KEY_P8',
        'APPLE_API_KEY_ID',
        'APPLE_API_ISSUER',
        'APPLE_ID',
        'APPLE_APP_SPECIFIC_PASSWORD',
        'APPLE_TEAM_ID'
      ]) {
        expect(summary).toContain(name)
      }
    })

    it('treats a flag of "false" as absent, which is what the workflow sends', () => {
      expect(plan({ HAS_CSC_LINK: 'false', HAS_CSC_KEY_PASSWORD: 'false' })).toMatchObject({ mode: 'unsigned', code: 0 })
    })
  })

  describe('with a complete set', () => {
    it('signs and notarizes with the App Store Connect key', () => {
      const result = plan({ ...CERT, ...API_KEY })
      expect(result).toMatchObject({ code: 0, mode: 'notarized', sign: 'true', notarize: 'api-key' })
      expect(result.stdout).not.toMatch(/^::warning/m)
    })

    it('signs and notarizes with an Apple ID', () => {
      expect(plan({ ...CERT, ...APPLE_ID })).toMatchObject({ code: 0, mode: 'notarized', notarize: 'apple-id' })
    })

    it('prefers the key when both are there', () => {
      expect(plan({ ...CERT, ...API_KEY, ...APPLE_ID })).toMatchObject({ notarize: 'api-key' })
    })
  })

  // A Developer ID signature alone is not enough: Gatekeeper still refuses an
  // app that was never notarized. Green, but it must not read as done.
  it('warns that a signed build with nothing to notarize with is still blocked', () => {
    const result = plan(CERT)
    expect(result).toMatchObject({ code: 0, mode: 'signed', sign: 'true', notarize: 'none' })
    expect(result.summary).toMatch(/NOT notarized/)
    expect(result.stdout).toMatch(/^::warning/m)
  })

  describe('with half a set', () => {
    // Quietly falling back to unsigned here would ship the very build the
    // owner just paid to stop shipping, on the day they thought they had.
    it('fails on a certificate with no password, and names what is missing', () => {
      const result = plan({ HAS_CSC_LINK: 'true' })
      expect(result.code).toBe(1)
      expect(result.summary).toContain('CSC_KEY_PASSWORD')
      expect(result.stdout).toMatch(/^::error/m)
    })

    it('fails on a partial App Store Connect key', () => {
      const result = plan({ ...CERT, HAS_APPLE_API_KEY_P8: 'true', HAS_APPLE_API_KEY_ID: 'true' })
      expect(result.code).toBe(1)
      expect(result.summary).toContain('APPLE_API_ISSUER')
    })

    it('fails on a partial Apple ID', () => {
      const result = plan({ ...CERT, HAS_APPLE_ID: 'true' })
      expect(result.code).toBe(1)
      expect(result.summary).toContain('APPLE_APP_SPECIFIC_PASSWORD')
      expect(result.summary).toContain('APPLE_TEAM_ID')
    })

    it('fails on notarization credentials with no certificate to sign with', () => {
      const result = plan(API_KEY)
      expect(result.code).toBe(1)
      expect(result.summary).toContain('CSC_LINK')
    })

    it('accepts a complete key beside a stray Apple ID value', () => {
      expect(plan({ ...CERT, ...API_KEY, HAS_APPLE_TEAM_ID: 'true' })).toMatchObject({ code: 0, notarize: 'api-key' })
    })
  })

  describe('on a pull request', () => {
    // electron-builder skips signing there too; this keeps the two agreed. It
    // does not stop a same-repo branch that edits the workflow: only an
    // environment restricted to tags does.
    it('stays unsigned even with every secret present', () => {
      const result = plan({ ...CERT, ...API_KEY }, 'pull_request')
      expect(result).toMatchObject({ code: 0, mode: 'unsigned', sign: 'false', notarize: 'none' })
      expect(result.summary).toMatch(/pull request/i)
    })

    it('does not fail over half a set it was never going to use', () => {
      expect(plan({ HAS_CSC_LINK: 'true' }, 'pull_request')).toMatchObject({ code: 0, mode: 'unsigned' })
    })
  })

  it('runs outside Actions without the two files, for a dry look', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: {} })
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/unsigned/)
    expect(existsSync(SCRIPT)).toBe(true)
  })
})
