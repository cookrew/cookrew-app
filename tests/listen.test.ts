import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MacListener, parseListenLine, type ListenEvent } from '../src/main/listen'

describe('parseListenLine', () => {
  it('reads the four shapes the helper emits', () => {
    expect(parseListenLine('{"ready":true,"locales":["zh-CN","en-US"],"onDevice":true}')).toEqual({
      kind: 'ready',
      locales: ['zh-CN', 'en-US'],
      onDevice: true
    })
    expect(parseListenLine('{"partial":"切换工作台到"}')).toEqual({ kind: 'partial', text: '切换工作台到' })
    expect(parseListenLine('{"final":"ask Conductor"}')).toEqual({ kind: 'final', text: 'ask Conductor' })
    expect(parseListenLine('{"final":"帮我问问双球","alternates":{"en-US":"ask Conductor","fr-FR":""}}')).toEqual({
      kind: 'final',
      text: '帮我问问双球',
      alternates: { 'en-US': 'ask Conductor' }
    })
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

function harness(locales = ['zh-CN', 'en-US']): {
  listener: MacListener
  children: FakeChild[]
  args: string[][]
  events: ListenEvent[]
  start: () => boolean
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'cr-listen-'))
  const binary = path.join(dir, 'cr-listen')
  writeFileSync(binary, '')
  const children: FakeChild[] = []
  const args: string[][] = []
  const events: ListenEvent[] = []
  const listener = new MacListener({
    binary,
    locales: () => locales,
    hints: () => ['Conductor', 'cookrew dev'],
    graceMs: 5,
    settleMs: 10,
    spawnFn: ((_bin: string, argv: string[]) => {
      const child = new FakeChild()
      children.push(child)
      args.push(argv)
      return child as never
    }) as never
  })
  return { listener, children, args, events, start: () => listener.start((e) => events.push(e)) }
}

const darwin = process.platform === 'darwin' ? it : it.skip

describe('MacListener — one child per ear', () => {
  darwin('spawns one helper per locale, hints to each; only the primary\'s partials are relayed', () => {
    const h = harness()
    expect(h.start()).toBe(true)
    expect(h.args).toEqual([
      ['--max-seconds', '30', '--locale', 'zh-CN', '--hint', 'Conductor', '--hint', 'cookrew dev'],
      ['--max-seconds', '30', '--locale', 'en-US', '--hint', 'Conductor', '--hint', 'cookrew dev']
    ])
    const [zh, en] = h.children
    zh.say('{"ready":true,"locales":["zh-CN"],"onDevice":true}')
    zh.say('{"partial":"帮我"}')
    en.say('{"partial":"help"}')
    zh.say('{"partial":"帮我问问"}')
    expect(h.events.map((e) => (e.kind === 'partial' ? e.text : e.kind))).toEqual(['ready', '帮我', '帮我问问'])
  })
  darwin('the finals are merged: the primary is the text, the others are alternates by locale', () => {
    const h = harness()
    h.start()
    const [zh, en] = h.children
    zh.say('{"final":"帮我问问双球"}')
    expect(h.events.filter((e) => e.kind === 'final')).toEqual([]) // waiting on the English ear
    en.say('{"final":"ask Conductor"}')
    expect(h.events.at(-1)).toEqual({ kind: 'final', text: '帮我问问双球', alternates: { 'en-US': 'ask Conductor' } })
    expect(h.listener.listening).toBe(false)
  })
  darwin('an alternate that is slow past the settle deadline is dropped and killed; the primary still lands', async () => {
    const h = harness()
    h.start()
    const [zh, en] = h.children
    zh.say('{"final":"切换到 agentmall"}')
    await new Promise((r) => setTimeout(r, 30))
    expect(h.events.at(-1)).toEqual({ kind: 'final', text: '切换到 agentmall' })
    expect(en.signals).toContain('SIGKILL')
  })
  darwin('an alternate that fails is just an alternate we do not have', () => {
    const h = harness()
    h.start()
    const [zh, en] = h.children
    en.say('{"error":"recognizer for en-US is not available"}')
    zh.say('{"final":"回到画布"}')
    expect(h.events.at(-1)).toEqual({ kind: 'final', text: '回到画布' })
  })
  darwin('the primary failing is the owner\'s problem', () => {
    const h = harness()
    h.start()
    h.children[0].say('{"error":"microphone not authorized"}')
    expect(h.events.at(-1)).toEqual({ kind: 'error', message: 'microphone not authorized' })
    expect(h.listener.listening).toBe(false)
  })
  darwin('one hold at a time — a second start while listening is refused', () => {
    const h = harness()
    expect(h.start()).toBe(true)
    expect(h.start()).toBe(false)
    expect(h.children).toHaveLength(2)
  })
  darwin('stop sends SIGINT to every ear, then SIGKILL to the ones that do not settle', async () => {
    const h = harness()
    h.start()
    h.listener.stop()
    expect(h.children.map((c) => c.signals)).toEqual([['SIGINT'], ['SIGINT']])
    await new Promise((r) => setTimeout(r, 20))
    expect(h.children[0].signals).toContain('SIGKILL')
  })
  darwin('ears that exit clean without a final said nothing — one empty final', () => {
    const h = harness()
    h.start()
    h.children[0].emit('exit', 0, null)
    h.children[1].emit('exit', 0, null)
    h.children[0].emit('exit', 0, null)
    expect(h.events.filter((e) => e.kind === 'final')).toEqual([{ kind: 'final', text: '' }])
  })
  darwin('a primary we stopped that died to the signal is silence, not a fault', () => {
    const h = harness(['zh-CN'])
    h.start()
    h.listener.stop()
    h.children[0].emit('exit', null, 'SIGINT')
    expect(h.events.at(-1)).toEqual({ kind: 'final', text: '' })
  })
  darwin('a primary that dies on its own is an error the owner can read', () => {
    const h = harness(['zh-CN'])
    h.start()
    h.children[0].emit('exit', 1, null)
    expect(h.events.at(-1)).toEqual({ kind: 'error', message: 'speech helper exited 1' })
  })
  it('without the helper binary there is no listening, and the reason is said', () => {
    const listener = new MacListener({ binary: '/nowhere/cr-listen', locales: () => ['en-US'], hints: () => [] })
    const events: ListenEvent[] = []
    expect(listener.start((e) => events.push(e))).toBe(false)
    expect(events[0]).toMatchObject({ kind: 'error' })
  })
})
