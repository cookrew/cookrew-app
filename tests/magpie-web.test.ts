import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { MagpieWeb, MAGPIE_WEB_PORTS, bareUrlOf, parseSsListeners, readHeld } from '../src/main/route/magpie-web'

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
    if (opened.ok) {
      // The address is bare: the key travels only as the cookie, which main keeps.
      expect(opened.url).toBe(bareUrlOf(MAGPIE_WEB_PORTS[1]))
      expect(opened.url).not.toContain(starts[0].key)
      expect(opened.cookie).toEqual({ name: `magpie_web_${MAGPIE_WEB_PORTS[1]}`, value: starts[0].key })
    }
    // Windows has no POSIX modes: there the file is 0666 whatever is asked (as the repo's other tests guard).
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
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
    expect(first).toMatchObject({ ok: true, port: MAGPIE_WEB_PORTS[2], url: bareUrlOf(MAGPIE_WEB_PORTS[2]), cookie: { value: 'cookrew-kept-key-1234567890' } })
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

describe('who listens, on Linux (ss)', () => {
  it('reads the owner pid of a loopback listener, and cannot tell for one ss cannot name', () => {
    const line = 'LISTEN 0      4096       127.0.0.1:3431      0.0.0.0:*    users:(("magpie",pid=4242,fd=7))'
    expect(parseSsListeners(line, 3431)).toEqual([4242])
    expect(parseSsListeners('', 3431)).toEqual([])
    expect(parseSsListeners('LISTEN 0      4096       127.0.0.1:3431      0.0.0.0:*', 3431)).toBeNull()
    expect(parseSsListeners(`${line}\nLISTEN 0 4096 127.0.0.1:3431 0.0.0.0:* users:(("nc",pid=99,fd=3))`, 3431)).toEqual([4242, 99])
    // A wildcard listener on the port also hears loopback: it counts.
    expect(parseSsListeners('LISTEN 0 4096 0.0.0.0:3431 0.0.0.0:* users:(("x",pid=1,fd=3))', 3431)).toEqual([1])
    expect(parseSsListeners('LISTEN 0 4096 [::]:3431 [::]:* users:(("x",pid=2,fd=3))', 3431)).toEqual([2])
    expect(parseSsListeners('LISTEN 0 4096 192.168.1.5:3431 0.0.0.0:* users:(("x",pid=3,fd=3))', 3431)).toEqual([])
    expect(parseSsListeners('LISTEN 0 4096 127.0.0.1:34310 0.0.0.0:* users:(("x",pid=4,fd=3))', 3431)).toEqual([])
  })
})
