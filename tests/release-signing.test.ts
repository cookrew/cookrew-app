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
const workflow = yaml.load(read('.github/workflows/release.yml')) as {
  env?: Record<string, string>
  jobs: { build: { env?: Record<string, string>; steps: Step[] } }
}
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
  const signedStep = steps.find((step) => step.env?.CSC_LINK !== undefined) as Step
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

  it('reads every named secret in the signed step, which runs only on a signing plan', () => {
    expect(signedStep.if).toContain("steps.signing.outputs.sign == 'true'")
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

  // Env set above the steps reaches every step, Windows included, so the check
  // above would miss a secret put there.
  it('sets no secret at workflow or job level', () => {
    expect(JSON.stringify(workflow.env ?? {})).not.toContain('secrets.')
    expect(JSON.stringify(workflow.jobs.build.env ?? {})).not.toContain('secrets.')
  })

  // With no flag, electron-builder picks onTagOrDraft on CI, and any branch's
  // dispatch can then overwrite a draft holding a verified tag build.
  it('publishes from a tag and from nothing else, on both build steps', () => {
    const plain = steps.find((step) => step.if?.includes("steps.signing.outputs.sign != 'true'")) as Step
    expect(plain.run).toContain('--publish onTag')
    expect(signedStep.run).toContain('--publish onTag')
  })

  // A build tool, its plugins and a native rebuild are code from npm. None of
  // them needs a certificate, so none of them runs beside one.
  it('bundles in a step of its own, so only electron-builder sees the secrets', () => {
    const bundle = steps.findIndex((step) => step.run?.trim() === 'npx electron-vite build')
    expect(bundle).toBeGreaterThan(-1)
    expect(bundle).toBeLessThan(steps.indexOf(signedStep))
    expect(usesSecret(steps[bundle])).toBe(false)
    expect(signedStep.run).not.toContain('npm run')
    expect(signedStep.run).toContain('npx electron-builder --mac')
    expect(signedStep.run).toContain('-c.npmRebuild=false')
  })

  it('removes the .p8 when the signed step ends, however it ends', () => {
    expect(signedStep.run).toMatch(/trap 'rm -f "\$APPLE_API_KEY"' EXIT/)
  })

  // build-cr-listen.mjs exits 0 when clang fails and a missing extraResource is
  // only a warning, so without this a release ships with a dead hold-to-talk.
  it('refuses to build for macOS without cr-listen', () => {
    const check = steps.findIndex((step) => step.run?.includes('test -x resources/cr-listen/cr-listen'))
    expect(check).toBeGreaterThan(-1)
    expect(steps[check].if).toContain("runner.os == 'macOS'")
    expect(check).toBeLessThan(steps.indexOf(signedStep))
  })

  // GitHub's images are not documented either way, and with assessments off
  // spctl answers "override=security disabled", which verify rightly fails.
  it('turns Gatekeeper on before verifying, and logs its state', () => {
    const verify = steps.find((step) => step.run?.includes('scripts/verify-mac-release.sh')) as Step
    expect(verify.run).toContain('spctl --status')
    expect(verify.run).toContain('sudo spctl --global-enable')
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

  // On a tag electron-builder has already uploaded to the draft by now, so this
  // gates the workflow artifact and turns the run red. The draft is the gate on
  // the release itself: the publish job runs only after this one is green.
  it('verifies a notarized build before the workflow artifact is uploaded', () => {
    const verify = steps.findIndex((step) => step.run?.includes('scripts/verify-mac-release.sh'))
    const upload = steps.findIndex((step) => step.uses?.startsWith('actions/upload-artifact'))
    expect(verify).toBeGreaterThan(steps.indexOf(signedStep))
    expect(verify).toBeLessThan(upload)
    expect(steps[verify].if).toContain("steps.signing.outputs.mode == 'notarized'")
  })
})

// THE FUSES (owner 2026-11-05: only Cookrew may read a sealed secret). The
// keychain's ACL trusts the signed binary, so anything that can run JS as that
// binary can open every value. These are the doors to that, and the one that
// must stay open: the `cookrew` shim is ELECTRON_RUN_AS_NODE on this binary.
describe('the fuses', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const hook = createRequire(import.meta.url)('../scripts/after-pack-fuses.cjs') as {
    fuseConfig: (options: Record<string, number>) => Record<string | number, unknown>
    default: (context: unknown) => Promise<void>
  }
  const O = { RunAsNode: 0, EnableNodeOptionsEnvironmentVariable: 2, EnableNodeCliInspectArguments: 3, EnableEmbeddedAsarIntegrityValidation: 4, OnlyLoadAppFromAsar: 5 }
  const config = hook.fuseConfig(O)

  it('run after the app is packed and before it is signed', () => {
    expect((yaml.load(read('electron-builder.yml')) as { afterPack?: string }).afterPack).toBe('scripts/after-pack-fuses.cjs')
  })

  it('shut the two ways to run code inside the real app', () => {
    expect(config[O.EnableNodeOptionsEnvironmentVariable]).toBe(false)
    expect(config[O.EnableNodeCliInspectArguments]).toBe(false)
  })

  it('load only the asar that was signed', () => {
    expect(config[O.OnlyLoadAppFromAsar]).toBe(true)
    expect(config[O.EnableEmbeddedAsarIntegrityValidation]).toBe(true)
  })

  it('keep RunAsNode on, or `cookrew` opens a second app', () => {
    expect(config[O.RunAsNode]).toBe(true)
    expect(read('src/main/cli-shim.ts')).toContain('ELECTRON_RUN_AS_NODE=1')
  })

  it('touch only the Mac build', async () => {
    await expect(hook.default({ electronPlatformName: 'win32' })).resolves.toBeUndefined()
  })
})
