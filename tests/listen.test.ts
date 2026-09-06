import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MacListener, parseListenLine, type ListenEvent } from '../src/main/listen'

describe('parseListenLine', () => {
  it('reads the four shapes the helper emits', () => {
    expect(parseListenLine('{"ready":true,"locale":"zh-CN","onDevice":true}')).toEqual({
      kind: 'ready',
      locale: 'zh-CN',
      onDevice: true
    })
    expect(parseListenLine('{"partial":"切换工作台到"}')).toEqual({ kind: 'partial', text: '切换工作台到' })
    expect(parseListenLine('{"final":"ask Conductor"}')).toEqual({ kind: 'final', text: 'ask Conductor' })
    expect(parseListenLine('{"error":"microphone not authorized"}')).toEqual({
      kind: 'error',
      message: 'microphone not authorized'
    })
  })
  it('noise is null, never a throw', () => {
    expect(parseListenLine('')).toBeNull()
    expect(parseListenLine('meter peak=0.1')).toBeNull()
    expect(parseListenLine('{"partial":42}')).toBeNull()
    expect(parseListenLine('[1,2]')).toBeNull()
  })
})

/** A child the test drives by hand: write to its stdout, exit it. */
class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
  stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
  signals: string[] = []
  kill(signal: string): boolean {
    this.signals.push(signal)
    return true
  }
  say(line: string): void {
    this.stdout.emit('data', `${line}\n`)
  }
}

function harness(): { listener: MacListener; children: FakeChild[]; args: string[][]; binary: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cr-listen-'))
  const binary = path.join(dir, 'cr-listen')
  writeFileSync(binary, '')
  const children: FakeChild[] = []
  const args: string[][] = []
  const listener = new MacListener({
    binary,
    locale: () => 'zh-CN',
    hints: () => ['Conductor', 'cookrew dev'],
    graceMs: 5,
    spawnFn: ((_bin: string, argv: string[]) => {
      const child = new FakeChild()
      children.push(child)
      args.push(argv)
      return child as never
    }) as never
  })
  return { listener, children, args, binary }
}

const darwin = process.platform === 'darwin' ? it : it.skip

describe('MacListener', () => {
  darwin('spawns the helper with the locale and every hint, and relays its lines', () => {
    const h = harness()
    const events: ListenEvent[] = []
    expect(h.listener.start((e) => events.push(e))).toBe(true)
    expect(h.args[0]).toEqual([
      '--locale', 'zh-CN', '--max-seconds', '30', '--hint', 'Conductor', '--hint', 'cookrew dev'
    ])
    const child = h.children[0]
    child.say('{"ready":true,"locale":"zh-CN","onDevice":true}')
    child.say('{"partial":"ask"}')
    child.say('{"partial":"ask Conductor"}')
    child.say('{"final":"ask Conductor"}')
    child.emit('exit', 0)
    expect(events.map((e) => e.kind)).toEqual(['ready', 'partial', 'partial', 'final'])
    expect(h.listener.listening).toBe(false)
  })
  darwin('one child at a time — a second start while listening is refused', () => {
    const h = harness()
    expect(h.listener.start(() => undefined)).toBe(true)
    expect(h.listener.start(() => undefined)).toBe(false)
    expect(h.children).toHaveLength(1)
  })
  darwin('stop sends SIGINT, then SIGKILL if the child does not settle in time', async () => {
    const h = harness()
    h.listener.start(() => undefined)
    h.listener.stop()
    expect(h.children[0].signals).toEqual(['SIGINT'])
    await new Promise((r) => setTimeout(r, 20))
    expect(h.children[0].signals).toEqual(['SIGINT', 'SIGKILL'])
  })
  darwin('a child that exits clean without a final said nothing — an empty final, once', () => {
    const h = harness()
    const events: ListenEvent[] = []
    h.listener.start((e) => events.push(e))
    h.children[0].emit('exit', 0)
    h.children[0].emit('exit', 0)
    expect(events).toEqual([{ kind: 'final', text: '' }])
  })
  darwin('a child that dies is an error the owner can read', () => {
    const h = harness()
    const events: ListenEvent[] = []
    h.listener.start((e) => events.push(e))
    h.children[0].emit('exit', 1, null)
    expect(events).toEqual([{ kind: 'error', message: 'speech helper exited 1' }])
  })
  darwin('a child we stopped that died to the signal said nothing — silence, not a fault', () => {
    const h = harness()
    const events: ListenEvent[] = []
    h.listener.start((e) => events.push(e))
    h.listener.stop()
    h.children[0].emit('exit', null, 'SIGINT')
    expect(events).toEqual([{ kind: 'final', text: '' }])
  })
  it('without the helper binary there is no listening, and the reason is said', () => {
    const listener = new MacListener({ binary: '/nowhere/cr-listen', locale: () => 'en-US', hints: () => [] })
    const events: ListenEvent[] = []
    expect(listener.start((e) => events.push(e))).toBe(false)
    expect(events[0]).toMatchObject({ kind: 'error' })
  })
})
