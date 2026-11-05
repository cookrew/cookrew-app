// A TYPECHECK IS 1.2-1.5 GB, AND AGENTS RUN THEM TOGETHER.
//
// Measured 2026-11-05: three `tsc --noEmit` at once in a machine already 20 GB
// over its RAM. vitest has a config to hook (scripts/heavy-slot.mjs); tsc has
// none. A PATH shim cannot reach it either: 39 of 40 sampled calls were
// `npx tsc`, and npx puts node_modules/.bin first. So owner panes load this
// through NODE_OPTIONS, which reaches every tsc in any repo. claude and codex
// are native binaries and ignore NODE_OPTIONS (checked).
//
// Every node in a pane loads this file, so it must do nothing for anything that
// is not tsc, and nothing in it may fail a run: it waits, capped, then lets go.
// The cap sits well under the Bash tool's default 120 s, or a run could be
// killed in the queue having done nothing.
// A slot is the same `<takenAt>-<pid>` file heavy-slot.mjs uses, so a dead run
// frees itself. It is written out at boot as plain CommonJS because it has to
// load before anything else, from a file that outlives the app's own bundle.
//
// A served pane never gets this: its sandbox may not be able to read the file,
// and node treats a preload it cannot load as fatal.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const TSC_GATE_FILE = path.join(homedir(), '.cookrew', 'bin', 'tsc-gate.cjs')

export const TSC_GATE_SOURCE = String.raw`'use strict'
// Written by Cookrew at boot (src/main/tsc-gate.ts). Edits here are overwritten.
;(() => {
  try {
    if (!/(?:^|\/)_?tsc(?:\.js)?$/.test(process.argv[1] || '')) return
    const env = process.env
    if (env.CI) return
    const free = new Set(['watch', 'w', 'version', 'v', 'help', 'h', '?', 'all', 'init', 'showconfig'])
    if (process.argv.slice(2).some((arg) => free.has(arg.replace(/^--?/, '').toLowerCase()))) return
    if (!require('node:worker_threads').isMainThread) return
    const raw = Number(env.COOKREW_TSC_SLOTS === undefined ? 2 : env.COOKREW_TSC_SLOTS)
    const slots = Number.isInteger(raw) && raw >= 0 ? raw : 2
    if (slots === 0) return
    const fs = require('node:fs')
    const path = require('node:path')
    const dir = env.COOKREW_TSC_SLOT_DIR || path.join(require('node:os').homedir(), '.cookrew', 'heavy-slots', 'tsc')
    const maxWait = Number(env.COOKREW_TSC_MAX_WAIT_MS) || 45000
    const poll = Number(env.COOKREW_TSC_POLL_MS) || 1000
    const maxAge = 30 * 60000
    const alive = (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        return error.code === 'EPERM'
      }
    }
    const held = () => {
      const live = []
      for (const name of fs.readdirSync(dir)) {
        const match = /^(\d+)-(\d+)$/.exec(name)
        if (!match) continue
        if (Date.now() - Number(match[1]) < maxAge && alive(Number(match[2]))) live.push(name)
        else fs.rmSync(path.join(dir, name), { force: true })
      }
      return live.sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b))
    }
    fs.mkdirSync(dir, { recursive: true })
    const started = Date.now()
    const mine = started + '-' + process.pid
    fs.writeFileSync(path.join(dir, mine), '')
    const sleeper = new Int32Array(new SharedArrayBuffer(4))
    let told = false
    for (;;) {
      const live = held()
      const rank = live.indexOf(mine)
      if (rank >= 0 && rank < slots) return
      if (Date.now() - started >= maxWait) {
        process.stderr.write('[tsc-gate] waited ' + Math.round(maxWait / 1000) + ' s, running anyway\n')
        return
      }
      if (!told) process.stderr.write('[tsc-gate] ' + (live.length - 1) + ' typecheck(s) ahead on this machine; waiting for a slot\n')
      told = true
      Atomics.wait(sleeper, 0, 0, poll)
    }
  } catch {
    // Nothing about this gate may be the reason a typecheck fails.
  }
})()
`

function alreadyInstalled(file: string): boolean {
  try {
    return readFileSync(file, 'utf8') === TSC_GATE_SOURCE
  } catch {
    return false
  }
}

/**
 * False when it could not be written; boot goes on, and panes then go without.
 * Live panes keep loading this file across app restarts, and node exits on a
 * truncated preload, so it is only ever replaced whole, and only when it changed.
 */
export function installTscGate(file: string = TSC_GATE_FILE): boolean {
  if (alreadyInstalled(file)) return true
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, TSC_GATE_SOURCE)
    renameSync(temp, file)
    return true
  } catch {
    return false
  }
}

/** NODE_OPTIONS for an owner pane: the owner's own, plus the gate once. */
export function tscGateOptions(file: string, existing: string | undefined): string {
  const flag = /\s/.test(file) ? `--require="${file}"` : `--require=${file}`
  if (existing?.includes(flag)) return existing
  return existing ? `${existing} ${flag}` : flag
}

/**
 * What an owner pane adds to its env. Empty when the file is not on disk: node
 * exits at once on a preload it cannot load, so a pane must never name one that
 * was not written. Empty on Windows too: node reads a backslash inside a quoted
 * option as an escape, so a profile path with a space would fail every run.
 */
export function tscGateEnv(
  existing: string | undefined,
  file: string = TSC_GATE_FILE,
  present: (file: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  return platform !== 'win32' && present(file) ? { NODE_OPTIONS: tscGateOptions(file, existing) } : {}
}
