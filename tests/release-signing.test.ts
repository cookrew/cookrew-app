import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * What a downloaded Cookrew needs from its packaging config. None of this can
 * be observed in a test run of the app: a wrong entitlement or a file left out
 * of the bundle shows up only on someone else's Mac, after a release, usually
 * as a feature that says nothing and does nothing.
 */

const ROOT = path.resolve(__dirname, '..')
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8')
const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown }

interface Resource {
  from: string
  to: string
}
interface BuilderConfig {
  files: string[]
  extraResources: Resource[]
  forceCodeSigning?: boolean
  mac: {
    hardenedRuntime?: boolean
    notarize?: boolean
    entitlements?: string
    entitlementsInherit?: string
    extendInfo: Record<string, string>
  }
}
interface Step {
  name?: string
  id?: string
  if?: string
  uses?: string
  run?: string
  env?: Record<string, string>
}

const builder = yaml.load(read('electron-builder.yml')) as BuilderConfig
const workflow = yaml.load(read('.github/workflows/release.yml')) as { jobs: { build: { steps: Step[] } } }
const steps = workflow.jobs.build.steps

/** The keys a plist turns on; a key named only in a comment does not count. */
const grantedBy = (xml: string): string[] =>
  [...xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((match) => match[1]).sort()

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })

describe('signing config', () => {
  it('turns on the hardened runtime and notarization', () => {
    expect(builder.mac.hardenedRuntime).toBe(true)
    expect(builder.mac.notarize).toBe(true)
  })

  // Forcing it here would turn "no secrets" into a red job, which is the one
  // thing the unsigned path must not be. The signed step forces it instead.
  it('does not force signing for every build', () => {
    expect(builder.forceCodeSigning).toBeUndefined()
  })

  it('points at entitlement files that exist', () => {
    expect(existsSync(path.join(ROOT, builder.mac.entitlements ?? 'missing'))).toBe(true)
    expect(existsSync(path.join(ROOT, builder.mac.entitlementsInherit ?? 'missing'))).toBe(true)
  })
})

describe('entitlements', () => {
  const main = (): string => read(builder.mac.entitlements ?? '')
  const inherit = (): string => read(builder.mac.entitlementsInherit ?? '')

  it('grants the main app V8, the microphone and the camera, and nothing else', () => {
    expect(grantedBy(main())).toEqual([
      'com.apple.security.cs.allow-jit',
      'com.apple.security.device.audio-input',
      'com.apple.security.device.camera'
    ])
  })

  it('grants the helpers and cr-listen V8 and the microphone, and nothing else', () => {
    expect(grantedBy(inherit())).toEqual([
      'com.apple.security.cs.allow-jit',
      'com.apple.security.device.audio-input'
    ])
  })

  // electron-builder's template hands out all three of the first group, and a
  // notarized build with get-task-allow is rejected outright.
  it('carries none of the broad defaults', () => {
    for (const xml of [main(), inherit()]) {
      for (const refused of [
        'com.apple.security.cs.disable-library-validation',
        'com.apple.security.cs.allow-unsigned-executable-memory',
        'com.apple.security.cs.allow-dyld-environment-variables',
        'com.apple.security.get-task-allow',
        'com.apple.security.app-sandbox'
      ]) {
        expect(grantedBy(xml)).not.toContain(refused)
      }
    }
  })

  it('justifies every grant in a comment right above it', () => {
    for (const xml of [main(), inherit()]) {
      for (const key of grantedBy(xml)) {
        expect(xml).toMatch(new RegExp(`-->\\s*<key>${key.replaceAll('.', '\\.')}</key>`))
      }
    }
  })
})

describe('the permission prompts', () => {
  it('has a sentence for every device the entitlements reach', () => {
    for (const key of ['NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription', 'NSCameraUsageDescription']) {
      expect(builder.mac.extendInfo[key]?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('does not name the retired canvas to the person reading the dialog', () => {
    for (const sentence of Object.values(builder.mac.extendInfo)) {
      expect(sentence).not.toMatch(/canvas/i)
    }
  })
})

describe('the bundle', () => {
  // v0.4.0 shipped without four of these. copyFileSync threw on the missing
  // CLI, the catch logged it, and no pane of a downloaded app ever had
  // `cookrew` on its PATH.
  it('ships everything main reads from process.resourcesPath', () => {
    const shipped = new Set(builder.extraResources.map((resource) => resource.to.split('/')[0]))
    const sources = walk(path.join(ROOT, 'src/main')).filter((file) => file.endsWith('.ts'))
    const read_ = sources.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/path\.join\(process\.resourcesPath,\s*'([^']+)'/g)].map((match) => match[1])
    )
    expect(read_.length).toBeGreaterThan(0)
    expect(read_.filter((name) => !shipped.has(name))).toEqual([])
  })

  it('takes every resource from a path that exists, bar the binary postinstall builds', () => {
    const missing = builder.extraResources
      .map((resource) => resource.from)
      .filter((from) => from !== 'resources/cr-listen/cr-listen')
      .filter((from) => !existsSync(path.join(ROOT, from)))
    expect(missing).toEqual([])
  })

  it('ships the CLI as a real file, not inside the asar main cannot copy it out of', () => {
    expect(builder.files.some((pattern) => pattern.startsWith('cli'))).toBe(false)
    expect(builder.extraResources).toContainEqual({ from: 'cli', to: 'cli' })
  })
})

describe('the herdr note in electron-builder.yml', () => {
  const header = read('electron-builder.yml').split('appId:')[0]

  it('no longer says herdr cannot host a terminal', () => {
    expect(header).not.toMatch(/cannot host/)
    expect(header).not.toContain('60,666')
  })

  it('says what the order is now', () => {
    expect(header).toMatch(/herdr/)
    expect(header).toMatch(/tmux/)
    expect(header).toMatch(/direct/)
  })
})

describe('release.yml', () => {
  const planStep = steps.find((step) => step.id === 'signing') as Step
  const signedStep = steps.find((step) => step.if?.includes("steps.signing.outputs.sign == 'true'")) as Step
  const usesSecret = (step: Step): boolean => JSON.stringify(step).includes('secrets.')

  it('plans on macOS only', () => {
    expect(planStep.if).toContain("runner.os == 'macOS'")
    expect(planStep.run).toContain('scripts/mac-signing-plan.mjs')
  })

  it('shows the plan step whether a secret exists, never its value', () => {
    const values = Object.values(planStep.env ?? {})
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) expect(value).toMatch(/^\$\{\{ secrets\.[A-Z0-9_]+ != '' \}\}$/)
  })

  it('reads every named secret in the signed step', () => {
    const env = JSON.stringify(signedStep.env)
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
      expect(env).toContain(`secrets.${name} `)
    }
  })

  // The Windows leg especially: electron-builder would try to sign an .exe
  // with a macOS CSC_LINK the moment it saw one.
  it('keeps signing material out of every other step', () => {
    const others = steps.filter((step) => step !== planStep && step !== signedStep && usesSecret(step))
    for (const step of others) {
      expect(JSON.stringify(step).match(/secrets\.[A-Z0-9_]+/g)).toEqual(['secrets.GITHUB_TOKEN'])
    }
  })

  it('builds the plain way on Windows and on an unsigned macOS run', () => {
    const plain = steps.find((step) => step.if?.includes("steps.signing.outputs.sign != 'true'")) as Step
    expect(plain.run).toContain('matrix.script')
    expect(plain.env?.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false')
  })

  // A signed run with a bad certificate must go red, not ship unsigned while
  // the summary says it signed.
  it('forces signing in the signed step', () => {
    expect(signedStep.run).toMatch(/forceCodeSigning=true/)
  })

  // electron-builder takes APPLE_API_KEY as a PATH to the .p8, so the secret's
  // text has to land in a file first.
  it('writes the App Store Connect key to a file and points electron-builder at it', () => {
    expect(signedStep.env?.APPLE_API_KEY).toBeUndefined()
    expect(signedStep.run).toContain('RUNNER_TEMP')
    expect(signedStep.run).toMatch(/export APPLE_API_KEY=/)
  })

  it('verifies a notarized build before anything is uploaded', () => {
    const verify = steps.findIndex((step) => step.run?.includes('scripts/verify-mac-release.sh'))
    const upload = steps.findIndex((step) => step.uses?.startsWith('actions/upload-artifact'))
    expect(verify).toBeGreaterThan(steps.indexOf(signedStep))
    expect(verify).toBeLessThan(upload)
    expect(steps[verify].if).toContain("steps.signing.outputs.mode == 'notarized'")
  })
})
