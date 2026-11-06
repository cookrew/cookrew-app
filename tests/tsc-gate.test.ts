// A TYPECHECK IS 1.2-1.5 GB, AND AGENTS RUN THEM TOGETHER.
//
// Measured 2026-11-05: three at once inside a machine already 20 GB over its
// RAM. 39 of 40 sampled calls are `npx tsc`, and npx puts node_modules/.bin
// first on PATH, so only a preload sees them all. These run REAL node processes
// with the preload, because what matters is what node does with it.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { installTscGate, tscGateEnv, tscGateOptions, TSC_GATE_SOURCE } from '../src/main/tsc-gate'

function rig() {
  const root = mkdtempSync(path.join(tmpdir(), 'tsc-gate-'))
  const gate = path.join(root, 'bin', 'tsc-gate.cjs')
  installTscGate(gate)
  const slots = path.join(root, 'slots')
  mkdirSync(slots)
  const tsc = path.join(root, 'tsc')
  writeFileSync(tsc, "process.stdout.write('ran')\n")
  const other = path.join(root, 'build.js')
  writeFileSync(other, "process.stdout.write('ran')\n")
  const env = (over: Record<string, string> = {}) => {
    const { CI: _ci, ...rest } = process.env
    return { ...rest, NODE_OPTIONS: `--require=${gate}`, COOKREW_TSC_SLOT_DIR: slots, COOKREW_TSC_SLOTS: '1', ...over }
  }
  return { gate, slots, tsc, other, env }
}

/** A slot held by this live test process, the same way a real run holds one. */
const holdSlot = (dir: string) => writeFileSync(path.join(dir, `${Date.now() - 1000}-${process.pid}`), '')

describe('the preload, in a real node', () => {
  it('lets a tsc run through and leaves its slot behind for the next look to sweep', () => {
    const r = rig()
    const out = spawnSync(process.execPath, [r.tsc], { env: r.env(), encoding: 'utf8' })
    expect(out.stdout).toBe('ran')
    expect(readdirSync(r.slots)).toHaveLength(1)
  })

  it('holds a tsc while the slots are full, and runs it when one frees', async () => {
    const r = rig()
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
    writeFileSync(path.join(r.slots, `${Date.now() - 1000}-${holder.pid}`), '')
    const child = spawn(process.execPath, [r.tsc], { env: r.env({ COOKREW_TSC_POLL_MS: '20' }) })
    const chunks: string[] = []
    child.stdout.on('data', (d) => chunks.push(String(d)))
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(chunks.join('')).toBe('')
    // The holder dying is what frees a slot: no release step exists to miss.
    holder.kill('SIGKILL')
    await new Promise((resolve) => child.once('exit', resolve))
    expect(chunks.join('')).toBe('ran')
  })

  it('gives up waiting and runs anyway: a slow typecheck beats a failed one', () => {
    const r = rig()
    holdSlot(r.slots)
    const out = spawnSync(process.execPath, [r.tsc], { env: r.env({ COOKREW_TSC_MAX_WAIT_MS: '100', COOKREW_TSC_POLL_MS: '20' }), encoding: 'utf8' })
    expect(out.stdout).toBe('ran')
    expect(out.stderr).toContain('tsc-gate')
  })

  it('waits well under the Bash tool\'s two minutes: a run killed in the queue did no work at all', () => {
    expect(TSC_GATE_SOURCE).toContain('|| 45000')
  })

  it('never touches another program', () => {
    const r = rig()
    holdSlot(r.slots)
    const out = spawnSync(process.execPath, [r.other], { env: r.env(), encoding: 'utf8', timeout: 5000 })
    expect(out.stdout).toBe('ran')
    expect(readdirSync(r.slots)).toHaveLength(1)
  })

  it('lets a watch or a version through: one stays open for hours, the other costs nothing', () => {
    const r = rig()
    holdSlot(r.slots)
    // tsc lowercases options and takes one dash or two (review: `-watch` held a slot).
    for (const flag of ['--watch', '-w', '-watch', '--Watch', '-W', '--version', '-V', '-version', '--help', '-?', '--showconfig']) {
      const out = spawnSync(process.execPath, [r.tsc, flag], { env: r.env(), encoding: 'utf8', timeout: 5000 })
      expect(out.stdout).toBe('ran')
    }
  })

  it('is off at zero slots and on CI', () => {
    const r = rig()
    holdSlot(r.slots)
    const offSwitches: Record<string, string>[] = [{ COOKREW_TSC_SLOTS: '0' }, { CI: '1' }]
    for (const over of offSwitches) {
      const out = spawnSync(process.execPath, [r.tsc], { env: r.env(over), encoding: 'utf8', timeout: 5000 })
      expect(out.stdout).toBe('ran')
    }
  })

  it('a slot directory it cannot use never stops a typecheck', () => {
    const r = rig()
    const out = spawnSync(process.execPath, [r.tsc], { env: r.env({ COOKREW_TSC_SLOT_DIR: '/dev/null/nope' }), encoding: 'utf8', timeout: 5000 })
    expect(out.stdout).toBe('ran')
    expect(out.status).toBe(0)
  })
})

describe('installTscGate', () => {
  it('writes the preload and replaces a stale one', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'tsc-gate-')), 'deep', 'tsc-gate.cjs')
    installTscGate(file)
    writeFileSync(file, 'stale')
    installTscGate(file)
    expect(readFileSync(file, 'utf8')).toBe(TSC_GATE_SOURCE)
  })

  it('reports failure instead of throwing: boot must go on', () => {
    expect(installTscGate('/dev/null/nope/tsc-gate.cjs')).toBe(false)
  })

  it('leaves an up-to-date file alone: every live pane loads it, so a boot must not truncate it', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'tsc-gate-')), 'tsc-gate.cjs')
    installTscGate(file)
    const before = statSync(file).ino
    installTscGate(file)
    expect(statSync(file).ino).toBe(before)
  })

  it('replaces a stale file by rename, never in place, and leaves no temp behind', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tsc-gate-'))
    const file = path.join(dir, 'tsc-gate.cjs')
    writeFileSync(file, 'stale')
    const before = statSync(file).ino
    installTscGate(file)
    expect(statSync(file).ino).not.toBe(before)
    expect(readdirSync(dir)).toEqual(['tsc-gate.cjs'])
  })
})

describe('tscGateOptions', () => {
  it('keeps the owner\'s own NODE_OPTIONS', () => {
    expect(tscGateOptions('/g.cjs', '--max-old-space-size=4096')).toBe('--max-old-space-size=4096 --require=/g.cjs')
    expect(tscGateOptions('/g.cjs', undefined)).toBe('--require=/g.cjs')
  })

  it('quotes a path node would otherwise split at the space', () => {
    expect(tscGateOptions('/Users/a b/g.cjs', undefined)).toBe('--require="/Users/a b/g.cjs"')
  })

  it('does not stack on a pane that already carries it', () => {
    expect(tscGateOptions('/g.cjs', '--require=/g.cjs')).toBe('--require=/g.cjs')
  })
})

describe('tscGateEnv', () => {
  it('is empty when the file is not there: node treats a missing preload as fatal', () => {
    expect(tscGateEnv(undefined, '/g.cjs', () => false)).toEqual({})
  })

  it('stays off Windows: node reads a backslash in a quoted option as an escape, and fails every run', () => {
    expect(tscGateEnv(undefined, 'C:\\Users\\a b\\g.cjs', () => true, 'win32')).toEqual({})
  })

  it('carries the gate when it is', () => {
    expect(tscGateEnv('--trace-warnings', '/g.cjs', () => true)).toEqual({ NODE_OPTIONS: '--trace-warnings --require=/g.cjs' })
  })
})
