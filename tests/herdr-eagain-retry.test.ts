import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHerdrRunner, retrySafeHerdrCommand } from '../src/main/herdr-host-multiplexer'
import { isTransientHerdrError, runWithHerdrRetry } from '../src/main/herdr-multiplexer'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function executableThatFails(failures: number, message: string): {
  bin: string
  countFile: string
  env: NodeJS.ProcessEnv
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-herdr-eagain-'))
  tempDirs.push(dir)
  const bin = path.join(dir, 'fake-herdr.cjs')
  const countFile = path.join(dir, 'count')
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs')
const file = process.env.HERDR_TEST_COUNT
const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1
fs.writeFileSync(file, String(count))
if (count <= Number(process.env.HERDR_TEST_FAILURES)) {
  process.stderr.write(process.env.HERDR_TEST_ERROR)
  process.exit(1)
}
process.stdout.write('ok')
`
  )
  chmodSync(bin, 0o755)
  return {
    bin,
    countFile,
    env: {
      ...process.env,
      HERDR_TEST_COUNT: countFile,
      HERDR_TEST_FAILURES: String(failures),
      HERDR_TEST_ERROR: message
    }
  }
}

const attempts = (countFile: string): number => Number(readFileSync(countFile, 'utf8'))

describe('herdr EAGAIN retry — a switch burst must not read as a dead server', () => {
  it('recognises the transient forms and nothing else', () => {
    expect(isTransientHerdrError({ code: 'EAGAIN' })).toBe(true)
    expect(isTransientHerdrError({ stderr: 'lost connection to server: Resource temporarily unavailable (os error 35)' })).toBe(true)
    expect(isTransientHerdrError({ message: 'spawn EAGAIN' })).toBe(true)
    expect(isTransientHerdrError({ stderr: 'no such pane' })).toBe(false)
    expect(isTransientHerdrError({ code: 'ENOENT' })).toBe(false)
    expect(isTransientHerdrError(null)).toBe(false)
  })

  it('retries a transient EAGAIN and returns the eventual success', () => {
    let n = 0
    const out = runWithHerdrRetry(() => {
      n++
      if (n < 3) throw { stderr: 'Resource temporarily unavailable (os error 35)' }
      return 'ok'
    })
    expect(out).toBe('ok')
    expect(n).toBe(3)
  })

  it('rethrows a NON-transient failure immediately, no retries', () => {
    let n = 0
    expect(() =>
      runWithHerdrRetry(() => {
        n++
        throw Object.assign(new Error('no such pane'), { stderr: 'no such pane' })
      })
    ).toThrow(/no such pane/)
    expect(n).toBe(1)
  })

  it('gives up after the last attempt if EAGAIN never clears — a real dead server still surfaces', () => {
    let n = 0
    expect(() =>
      runWithHerdrRetry(() => {
        n++
        throw { code: 'EAGAIN' }
      }, 4)
    ).toThrow()
    expect(n).toBe(4)
  })
})

describe.skipIf(process.platform === 'win32')('the production herdr host runner', () => {
  it('retries a read that hits os error 35 and returns the eventual response', () => {
    const fixture = executableThatFails(
      2,
      'lost connection to server: Resource temporarily unavailable (os error 35)'
    )
    const runner = createHerdrRunner(fixture.env)

    expect(runner.run(fixture.bin, ['pane', 'list'])).toBe('ok')
    expect(attempts(fixture.countFile)).toBe(3)
  })

  it('retries a liveness probe instead of reporting a healthy server dead', () => {
    const fixture = executableThatFails(2, 'spawn EAGAIN')
    const runner = createHerdrRunner(fixture.env)

    expect(runner.probe(fixture.bin, ['pane', 'list'])).toBe(true)
    expect(attempts(fixture.countFile)).toBe(3)
  })

  it('does not repeat a mutation after an ambiguous lost reply', () => {
    const fixture = executableThatFails(1, 'Resource temporarily unavailable (os error 35)')
    const runner = createHerdrRunner(fixture.env)

    expect(() => runner.run(fixture.bin, ['pane', 'split'])).toThrow()
    expect(attempts(fixture.countFile)).toBe(1)
  })

  it('classifies only side-effect-free commands as retryable', () => {
    expect(retrySafeHerdrCommand(['pane', 'list'])).toBe(true)
    expect(retrySafeHerdrCommand(['agent', 'get', 'w1:p1'])).toBe(true)
    expect(retrySafeHerdrCommand(['workspace', 'list'])).toBe(true)
    expect(retrySafeHerdrCommand(['pane', 'split'])).toBe(false)
    expect(retrySafeHerdrCommand(['pane', 'send-text'])).toBe(false)
  })
})
