// A PANE'S MIRROR STARTS AT THE SIZE THE PANE HAD (main/pane-sizes.ts): the
// mirror's attach sizes the shared pane, and the old default shrank every
// pane to 100x30 under whoever watched it (2026-11-01, Tinker 208x52 -> 100x30).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPaneSizes, PANE_SIZES_MAX } from '../src/main/pane-sizes'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pane-sizes-'))
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('pane sizes', () => {
  it('remembers the last size, writes it once a second, and a new store reads it back', () => {
    const file = path.join(dir, 'pane-sizes.json')
    const sizes = createPaneSizes(file)
    sizes.remember('t1', { cols: 208, rows: 52 })
    sizes.remember('t1', { cols: 207, rows: 52 })
    sizes.remember('t1', { cols: 208, rows: 52 })
    expect(sizes.get('t1')).toEqual({ cols: 208, rows: 52 })
    vi.advanceTimersByTime(1000)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ t1: { cols: 208, rows: 52 } })
    expect(createPaneSizes(file).get('t1')).toEqual({ cols: 208, rows: 52 })
    expect(createPaneSizes(file).get('nobody')).toBeNull()
  })

  it('refuses sizes no terminal has, and keeps a bounded number', () => {
    const sizes = createPaneSizes(path.join(dir, 'p.json'))
    sizes.remember('a', { cols: 0, rows: 30 })
    sizes.remember('b', { cols: 100.5, rows: 30 })
    expect(sizes.get('a')).toBeNull()
    expect(sizes.get('b')).toBeNull()
    for (let i = 0; i <= PANE_SIZES_MAX; i++) sizes.remember(`t${i}`, { cols: 100, rows: 30 })
    expect(sizes.get('t0')).toBeNull()
    expect(sizes.get(`t${PANE_SIZES_MAX}`)).toEqual({ cols: 100, rows: 30 })
  })

  it('flush writes now; a missing or broken file starts empty', () => {
    const file = path.join(dir, 'q.json')
    const sizes = createPaneSizes(file)
    sizes.remember('t', { cols: 120, rows: 40 })
    sizes.flush()
    expect(JSON.parse(readFileSync(file, 'utf8')).t).toEqual({ cols: 120, rows: 40 })
    expect(createPaneSizes(path.join(dir, 'none.json')).get('t')).toBeNull()
  })
})

describe('the mirror starts at the remembered size', () => {
  it('PtyManager.spawn passes the size the pane last had, and records every applied size', async () => {
    const { readFileSync: read } = await import('node:fs')
    const pty = read(path.join(__dirname, '..', 'src/main/pty.ts'), 'utf8')
    expect(pty).toContain('...(known ? { cols: known.cols, rows: known.rows } : {}),')
    expect(pty).toContain("session.on('resized', (size: { cols: number; rows: number }) => paneSizes().remember(options.terminalId, size))")
    expect(pty).toMatch(/this\.emit\('resized', \{ cols, rows \}\)/)
  })
})
