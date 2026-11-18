import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { MagpieWeb, MAGPIE_WEB_PORTS, linkOf, readHeld } from '../src/main/route/magpie-web'

/** A stand-in child: exitCode stays null until killed. */
function fakeChild(): ChildProcess & { killed: boolean } {
  const child = new EventEmitter() as unknown as ChildProcess & { killed: boolean; exitCode: number | null }
  child.exitCode = null
  // The listener the fake page reports is this child (MagpieWeb fails closed on anything else).
  ;(child as unknown as { pid: number }).pid = 4242
  child.killed = false
  child.kill = (() => {
    child.killed = true
    child.exitCode = 0
    child.emit('exit', 0)
    return true
  }) as ChildProcess['kill']
  return child
}

let dir = ''
let file = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'magpie-web-'))
  file = path.join(dir, 'magpie-web.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('MagpieWeb', () => {
  it('says plainly when Magpie is not here', async () => {
    expect(await new MagpieWeb({ bin: () => null, file }).open()).toEqual({ ok: false, why: 'Magpie is not installed on this computer.' })
  })

  it('starts the page on the first free port, keeps key and port 0600, and hands back the sign-in link', async () => {
    const starts: { port: number; key: string }[] = []
    const up = new Set<number>()
    const web = new MagpieWeb({
      bin: () => '/bin/magpie',
      file,
      portFree: async (port) => port !== MAGPIE_WEB_PORTS[0],
      answers: async (port) => up.has(port),
      start: (_bin, port, key) => {
        starts.push({ port, key })
        up.add(port)
        return fakeChild()
      },
      wait: async () => undefined,
      // A fake child listens nowhere: who listens cannot be read here.
      listeners: async () => [4242]
    })
    const opened = await web.open()
    expect(opened).toMatchObject({ ok: true, port: MAGPIE_WEB_PORTS[1] })
    const held = readHeld(file)
    expect(held).toEqual({ key: starts[0].key, port: MAGPIE_WEB_PORTS[1] })
    if (opened.ok) expect(opened.url).toBe(linkOf(MAGPIE_WEB_PORTS[1], starts[0].key))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(starts[0].key).toMatch(/^[A-Za-z0-9._~-]{16,128}$/)
  })

  it('reuses the running page and the saved key and port: a new port would be a new sign-in', async () => {
    writeFileSync(file, JSON.stringify({ key: 'cookrew-kept-key-1234567890', port: MAGPIE_WEB_PORTS[2] }))
    let starts = 0
    const up = new Set<number>()
    const web = new MagpieWeb({
      bin: () => '/bin/magpie',
      file,
      portFree: async () => true,
      answers: async (port) => up.has(port),
      start: (_bin, port) => {
        starts += 1
        up.add(port)
        return fakeChild()
      },
      wait: async () => undefined,
      // A fake child listens nowhere: who listens cannot be read here.
      listeners: async () => [4242]
    })
    const first = await web.open()
    const second = await web.open()
    expect(starts).toBe(1)
    expect(first).toEqual(second)
    expect(first).toMatchObject({ ok: true, port: MAGPIE_WEB_PORTS[2], url: linkOf(MAGPIE_WEB_PORTS[2], 'cookrew-kept-key-1234567890') })
  })

  it('reports a page that never answers, and stops it', async () => {
    const child = fakeChild()
    const web = new MagpieWeb({ bin: () => '/bin/magpie', file, portFree: async () => true, answers: async () => false, start: () => child, wait: async () => undefined })
    expect(await web.open()).toEqual({ ok: false, why: 'Magpie’s page did not answer in time.' })
    expect(child.killed).toBe(true)
  })

  it('hands the link to no page but its own: a squatter on the port gets nothing', async () => {
    const child = fakeChild()
    ;(child as unknown as { pid: number }).pid = 4242
    const web = new MagpieWeb({ bin: () => '/bin/magpie', file, portFree: async () => true, answers: async () => true, start: () => child, wait: async () => undefined, listeners: async () => [9999] })
    const opened = await web.open()
    expect(opened).toMatchObject({ ok: false, why: expect.stringContaining('Could not confirm') })
    expect(JSON.stringify(opened)).not.toContain('?k=')
    expect(child.killed).toBe(true)
  })

  it('opens only when listener identity is known and uniquely matches the child', async () => {
    for (const listeners of [async () => [4242]]) {
      const child = fakeChild()
      ;(child as unknown as { pid: number }).pid = 4242
      const web = new MagpieWeb({ bin: () => '/bin/magpie', file, portFree: async () => true, answers: async () => true, start: () => child, wait: async () => undefined, listeners })
      expect(await web.open()).toMatchObject({ ok: true })
    }
  })

  it('fails closed if listener identity is unavailable or ambiguous', async () => {
    for (const listeners of [async () => null, async () => [4242, 7]]) {
      const child = fakeChild()
      ;(child as unknown as { pid: number }).pid = 4242
      const web = new MagpieWeb({ bin: () => '/bin/magpie', file, portFree: async () => true, answers: async () => true, start: () => child, wait: async () => undefined, listeners })
      const answer = await web.open()
      expect(answer.ok).toBe(false)
      expect(JSON.stringify(answer)).not.toContain('?k=')
    }
  })

  it('ignores a held file that is not ours', () => {
    writeFileSync(file, JSON.stringify({ key: 'short', port: 3431 }))
    expect(readHeld(file)).toBeNull()
    writeFileSync(file, JSON.stringify({ key: 'cookrew-kept-key-1234567890', port: 80 }))
    expect(readHeld(file)).toBeNull()
    expect(readFileSync(file, 'utf8')).toContain('80')
  })
})

describe('who may reach Magpie’s page', () => {
  const read = (rel: string): string => readFileSync(path.join(__dirname, '../src', rel), 'utf8')
  it('keeps its key out of the served sandbox and its ports closed to it', () => {
    expect(read('main/owner-secrets.ts')).toContain("path.join(base, 'magpie-web.json')")
    expect(read('main/route/service.ts')).toMatch(/MAGPIE_WEB_PORTS/)
  })
})
